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
const { pathToFileURL } = require('url');

const STATE_DIR = path.join(os.tmpdir(), 'animax');
const CURRENT_FILE = path.join(STATE_DIR, 'current.json');
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
    const next = classify(evt);
    if (!next) return;
    const prev = readJson(sessionFile(evt.session_id) || CURRENT_FILE);
    recordState(evt.session_id, next, prev);
    if (evt.hook_event_name === 'SessionEnd') {
      const f = sessionFile(evt.session_id);
      if (f) try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  } catch {
    // A decorative plugin must never break Claude Code.
  }
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
    default: usage();
  }
}

main();
