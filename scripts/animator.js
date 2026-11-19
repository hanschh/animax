#!/usr/bin/env node
/**
 * animax: the terminal side (command hooks, status line, watch pane).
 *
 * Claude Code captures hook stdout and renders its own TUI. Writing escape
 * sequences straight to the TTY from a hook would corrupt the spinner line
 * ("Flibbertigibbeting…", "Thinking…", "Analyzing…"). So the work is split:
 *
 *   hook        Called by hooks/hooks.json. Reads the hook event JSON on stdin,
 *               classifies it, and writes the state atomically to a file.
 *               Prints NOTHING and always exits 0.
 *   statusline  For settings.json "statusLine". Prints ONE line with the
 *               current frame. Claude Code owns that line.
 *   watch       Full multi-line animation for a separate terminal pane, drawn
 *               in the alternate screen buffer and restored on exit.
 *   demo        Like watch, but cycles through every state.
 *   set <state> Force a state manually (handy for testing).
 *   config      Print the statusLine snippet for ~/.claude/settings.json.
 *
 * The in-app animation (spinner line + /animax pane, terminal and VS Code)
 * lives in hooks/register.tsx. Both share the art in scripts/core.mjs.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const STATE_DIR = path.join(os.tmpdir(), 'animax');
const CURRENT_FILE = path.join(STATE_DIR, 'current.json');
const PLAYER_FILE = path.join(STATE_DIR, 'player.json'); // the looping soundtrack: { pid, state }
const HOME_DIR = path.join(os.homedir(), '.animax');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json'); // { sound: false } after `mute`
const CODEX_COPY = path.join(HOME_DIR, 'codex'); // the copy Codex hooks run
const CODEX_HOOKS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
const ROOT = path.join(__dirname, '..');
const STALE_MS = 10 * 60 * 1000; // a non-idle state this old means a crashed session

let core; // scripts/core.mjs, loaded in main()
let pixels; // scripts/pixels.mjs, loaded for watch/demo
let video = null; // assets/video.mjs, once scripts/build-assets.mjs has run

// ─── State storage ──────────────────────────────────────────────────────────

function sessionFile(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return safe ? path.join(STATE_DIR, `session-${safe}.json`) : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(data);
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while a reader holds the file; fall back.
    try { fs.writeFileSync(file, body); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function loadState(sessionId) {
  const f = sessionFile(sessionId);
  return (f && readJson(f)) || readJson(CURRENT_FILE) || { state: 'idle', since: 0 };
}

/** Which state to display, given the stored record and the clock. */
function effectiveState(rec, now = Date.now()) {
  if (!rec || !core.STATES.includes(rec.state)) return { state: 'idle', detail: '' };
  if (rec.state !== 'idle' && now - (rec.since || 0) > STALE_MS) return { state: 'idle', detail: '' };
  // Edits finish in milliseconds; without a hold, "coding" would only flash.
  if (rec.state === 'thinking' && rec.active && now - rec.active.at < core.ACTIVE_HOLD_MS) {
    return { state: rec.active.state, detail: rec.active.detail || '' };
  }
  return { state: rec.state, detail: rec.detail || '' };
}

// ─── hook ───────────────────────────────────────────────────────────────────

function classify(evt) {
  switch (evt.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'thinking', detail: 'reading prompt' };
    case 'PreToolUse': return core.classifyTool(evt.tool_name, evt.tool_input || {});
    case 'PostToolUse': return { state: 'thinking', detail: 'analyzing result' };
    case 'SubagentStop': return { state: 'thinking', detail: 'subagent done' };
    case 'SessionStart':
    case 'Stop':
    case 'SessionEnd': return { state: 'idle', detail: '' };
    default: return null;
  }
}

function recordState(sessionId, next, prev) {
  const now = Date.now();
  const rec = { state: next.state, detail: next.detail || '', since: now, session: sessionId || '' };
  // Remember the last "active" state so the renderer can hold it a moment.
  if (next.state === 'thinking') {
    if (prev && core.ACTIVE_STATES.includes(prev.state)) {
      rec.active = { state: prev.state, detail: prev.detail, at: now };
    } else if (prev && prev.active) {
      rec.active = prev.active;
    }
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const f = sessionFile(sessionId);
  if (f) writeJsonAtomic(f, rec);
  writeJsonAtomic(CURRENT_FILE, rec);
}

function runHook() {
  try {
    if (process.stdin.isTTY) return; // run by hand without input: do nothing
    const raw = fs.readFileSync(0, 'utf8');
    const evt = raw.trim() ? JSON.parse(raw) : {};
    if (process.env.ANIMAX_DEBUG) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(path.join(STATE_DIR, 'hook.log'), `${raw.trim()}\n`);
    }
    const next = classify(evt);
    if (!next) return;
    const prev = readJson(sessionFile(evt.session_id) || CURRENT_FILE);
    recordState(evt.session_id, next, prev);
    if (evt.hook_event_name === 'SessionEnd') {
      const f = sessionFile(evt.session_id);
      if (f) try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    // Codex has no in-app player, so its hooks play the sound themselves.
    if (process.argv.includes('--sound')) followSound(evt, next);
  } catch {
    // A decorative plugin must never break Claude Code.
  }
}

// ─── sound (Codex hooks) ────────────────────────────────────────────────────

function isSoundOn() {
  const c = readJson(CONFIG_FILE);
  return !(c && c.sound === false);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPlayer() {
  const p = readJson(PLAYER_FILE);
  if (p && p.pid) {
    try {
      // A process group on macOS and Linux takes the player's child with it.
      process.kill(process.platform === 'win32' ? p.pid : -p.pid);
    } catch { /* already gone */ }
  }
  try { fs.unlinkSync(PLAYER_FILE); } catch { /* ignore */ }
}

function startPlayer(state) {
  const wav = path.join(ROOT, 'assets', 'audio', `${state}.wav`);
  if (!fs.existsSync(wav)) return stopPlayer();
  const p = readJson(PLAYER_FILE);
  if (p && p.state === state && isAlive(p.pid)) return; // already looping this one
  stopPlayer();
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  let child;
  if (process.platform === 'win32') {
    const file = wav.replace(/'/g, "''");
    const script = `$p = New-Object System.Media.SoundPlayer '${file}'; $p.PlayLooping(); Start-Sleep -Seconds 1800`;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], opts);
  } else {
    const play = process.platform === 'darwin' ? 'afplay "$0"' : '(aplay -q "$0" || paplay "$0")';
    // Stop after 30 minutes, as the Windows player does, if no hook ends it.
    child = spawn('sh', ['-c', `end=$(( $(date +%s) + 1800 )); while [ $(date +%s) -lt $end ]; do ${play} || exit; done`, wav], opts);
  }
  child.on('error', () => { /* no player on this system */ });
  child.unref();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(PLAYER_FILE, { pid: child.pid, state });
}

/** Loop the soundtrack of the state a hook event starts; stop it when the turn ends. */
function followSound(evt, next) {
  const name = evt.hook_event_name;
  if (name === 'Stop' || name === 'SessionEnd' || name === 'SessionStart' || !isSoundOn()) return stopPlayer();
  // After a tool the bot is "analyzing": keep the clip that is playing.
  if (name === 'UserPromptSubmit' || name === 'PreToolUse') startPlayer(next.state);
}

function runMute(sound) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const c = readJson(CONFIG_FILE) || {};
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...c, sound }, null, 2));
  if (!sound) stopPlayer();
  console.log(sound ? 'animax sound on.' : 'animax muted.');
}

// ─── Codex install ──────────────────────────────────────────────────────────

const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd'];
const isAnimaxHook = h => /animax/i.test(String((h && h.command) || ''));

function readCodexHooks() {
  const data = readJson(CODEX_HOOKS);
  if (fs.existsSync(CODEX_HOOKS) && !data) {
    throw new Error(`${CODEX_HOOKS} is not valid JSON; fix or move it first.`);
  }
  return data && typeof data === 'object' ? data : {};
}

/** Drop animax's own entries from every event, keeping everything else. */
function withoutAnimax(data) {
  const hooks = { ...(data.hooks || {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isAnimaxHook(h)) }))
      .filter(g => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...data, hooks };
}

function copyTree(from, to, keep) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    if (entry.isDirectory()) copyTree(src, path.join(to, entry.name), keep);
    else if (keep(entry.name)) fs.copyFileSync(src, path.join(to, entry.name));
  }
}

function runCodexInstall() {
  const data = withoutAnimax(readCodexHooks());
  // Hooks run a copy, so updating or moving this folder never breaks them.
  fs.rmSync(CODEX_COPY, { recursive: true, force: true });
  copyTree(path.join(ROOT, 'scripts'), path.join(CODEX_COPY, 'scripts'), n => /\.(js|mjs)$/.test(n) && n !== 'build-assets.mjs');
  copyTree(path.join(ROOT, 'assets'), path.join(CODEX_COPY, 'assets'), n => /\.(mjs|wav)$/.test(n));

  const script = path.join(CODEX_COPY, 'scripts', 'animator.js').replace(/\\/g, '/');
  const command = `node "${script}" hook --sound`;
  for (const event of CODEX_EVENTS) {
    const handler = { type: 'command', command, timeout: event === 'SessionEnd' ? 2 : 5 };
    data.hooks[event] = [...(data.hooks[event] || []), { hooks: [handler] }];
  }
  fs.mkdirSync(path.dirname(CODEX_HOOKS), { recursive: true });
  fs.writeFileSync(CODEX_HOOKS, `${JSON.stringify(data, null, 2)}\n`);

  console.log(`animax hooks added to ${CODEX_HOOKS}
animax copied to ${CODEX_COPY}

Next:
  1. Codex runs new hooks only after you trust them. Open a terminal and run
     codex, type /hooks, and trust the animax hooks.
  2. Watch the bot in a split terminal:  node "${script}" watch
  3. Sound: node "${script}" mute   (or unmute)

Run this again after updating animax; remove with codex-uninstall.`);
}

function runCodexUninstall() {
  const data = withoutAnimax(readCodexHooks());
  if (fs.existsSync(CODEX_HOOKS)) fs.writeFileSync(CODEX_HOOKS, `${JSON.stringify(data, null, 2)}\n`);
  stopPlayer();
  fs.rmSync(CODEX_COPY, { recursive: true, force: true });
  console.log(`animax hooks removed from ${CODEX_HOOKS}, and ${CODEX_COPY} deleted.`);
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

const USE_COLOR = !process.env.NO_COLOR;
const ESC = '\x1b[';
const paint = (code, s) => (USE_COLOR ? `${ESC}${code}m${s}${ESC}0m` : s);
const dim = s => paint(2, s);
const bold = s => paint(1, s);

function frameFor(list, state, now = Date.now()) {
  return core.pick(list, Math.floor(now / (1000 / core.META[state].fps)));
}

// ─── statusline ─────────────────────────────────────────────────────────────

function runStatusline() {
  let input = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = fs.readFileSync(0, 'utf8');
      if (raw.trim()) input = JSON.parse(raw);
    }
  } catch { /* ignore */ }

  const { state, detail } = effectiveState(loadState(input.session_id));
  const m = core.META[state];
  const parts = [paint(m.ansi, frameFor(core.MINI[state], state)), paint(`1;${m.ansi}`, m.label)];
  if (detail) parts.push(dim(detail));
  const model = input.model && input.model.display_name;
  if (model) parts.push(dim(`| ${model}`));
  // Single line, no cursor movement: Claude Code places it for us.
  process.stdout.write(parts.join(' '));
}

// ─── watch / demo ───────────────────────────────────────────────────────────

function runWatch({ demo = false, session = null } = {}) {
  const out = process.stdout;
  if (!out.isTTY) {
    console.error('animax watch needs an interactive terminal.');
    process.exit(1);
  }
  // Alternate screen + hidden cursor: the user's scrollback stays untouched.
  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
  };
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restore(); process.exit(0); });
  }
  out.on('resize', () => out.write(`${ESC}2J`));

  const demoOrder = ['thinking', 'planning', 'coding', 'testing', 'idle'];
  const started = Date.now();

  const tick = () => {
    const now = Date.now();
    let state, detail;
    if (demo) {
      state = demoOrder[Math.floor((now - started) / 4000) % demoOrder.length];
      detail = 'demo mode';
    } else {
      ({ state, detail } = effectiveState(loadState(session), now));
    }
    const m = core.META[state];
    const cols = out.columns || 80;
    const fit = s => (s.length > cols ? s.slice(0, cols) : s);
    const clip = video && video.states[state];

    let buf = `${ESC}H`; // home, then overwrite in place: no flicker, no scroll
    buf += `${fit(` ${bold('animax')} ${dim('· Ctrl+C to quit')}`)}${ESC}K\n${ESC}K\n`;
    if (clip && cols >= clip.large.w + 2) {
      // Video frame as truecolor half blocks (2 pixels per cell).
      const frames = clip.large.frames;
      const i = Math.floor(now / (1000 / video.fps)) % frames.length;
      for (const line of pixels.ansiLines(pixels.frameIndices(frames[i], clip.large.w, clip.large.h), clip.large.w, clip.large.h, clip.palette)) {
        buf += `  ${line}${ESC}K\n`;
      }
    } else {
      for (const line of frameFor(core.FRAMES[state], state, now)) buf += `${paint(m.ansi, fit('  ' + line))}${ESC}K\n`;
    }
    buf += `${ESC}K\n`;
    buf += `  ${paint(`1;${m.ansi}`, m.label.toUpperCase())} ${dim(fit(detail || ''))}${ESC}K\n`;
    buf += `${ESC}J`; // clear anything left below from a taller previous frame
    out.write(buf);
  };

  tick();
  setInterval(tick, video ? Math.round(1000 / video.fps) : 100);
}

// ─── misc commands ──────────────────────────────────────────────────────────

function runSet(state) {
  if (!core.STATES.includes(state)) {
    console.error(`Unknown state "${state}". Use one of: ${core.STATES.join(', ')}`);
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(CURRENT_FILE, { state, detail: 'manual', since: Date.now() });
  console.log(`animax state -> ${state}`);
}

function runConfig() {
  const script = path.resolve(__filename).replace(/\\/g, '/');
  const snippet = { statusLine: { type: 'command', command: `node "${script}" statusline`, padding: 0 } };
  console.log(JSON.stringify(snippet, null, 2));
}

function usage() {
  console.log(`animax: ASCII animations for Claude Code

Usage: node animator.js <command>

  hook          (used by hooks.json) read hook JSON on stdin, record state
  statusline    print one animated line for Claude Code's statusLine
  watch         full-size animation in this terminal (use a split pane)
  demo          cycle through all states
  set <state>   force a state: ${core.STATES.join(', ')}
  config        print the statusLine snippet for ~/.claude/settings.json
  mute|unmute   sound off or on for Codex hooks (hook --sound)
  codex-install    add animax hooks to ~/.codex/hooks.json (Codex CLI and IDE)
  codex-uninstall  remove them again

State dir: ${STATE_DIR}`);
}

async function main() {
  try {
    core = await import(pathToFileURL(path.join(__dirname, 'core.mjs')).href);
  } catch (err) {
    // Never fail a hook because of a broken install.
    if (process.argv[2] !== 'hook') console.error(`animax: cannot load core.mjs: ${err.message}`);
    return;
  }
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'watch' || cmd === 'demo') {
    try {
      pixels = await import(pathToFileURL(path.join(__dirname, 'pixels.mjs')).href);
      video = (await import(pathToFileURL(path.join(__dirname, '..', 'assets', 'video.mjs')).href)).VIDEO;
    } catch {
      video = null; // ASCII fallback
    }
  }
  switch (cmd) {
    case 'hook': runHook(); break;
    case 'statusline': runStatusline(); break;
    case 'watch': runWatch({ session: arg }); break;
    case 'demo': runWatch({ demo: true }); break;
    case 'set': runSet(arg); break;
    case 'config': runConfig(); break;
    case 'mute': runMute(false); break;
    case 'unmute': runMute(true); break;
    case 'codex-install': runCodexInstall(); break;
    case 'codex-uninstall': runCodexUninstall(); break;
    default: usage();
  }
}

main();
