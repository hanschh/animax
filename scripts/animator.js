#!/usr/bin/env node
/**
 * animax — ASCII state animations for Claude Code.
 *
 * Claude Code captures hook stdout and renders its own TUI (Ink). Writing
 * escape sequences straight to the TTY from a hook would corrupt the spinner
 * line ("Flibbertigibbeting…", "Thinking…", "Analyzing…"). So the work is split:
 *
 *   hook        Called by hooks/hooks.json. Reads the hook event JSON on stdin,
 *               classifies it into a state, writes it atomically to a state
 *               file. Prints NOTHING and always exits 0.
 *   statusline  For settings.json "statusLine". Prints ONE line with the
 *               current frame. Claude Code owns that line, so the log is safe.
 *   watch       Full multi-line animation for a separate terminal pane, drawn
 *               in the alternate screen buffer and restored on exit.
 *   demo        Like watch, but cycles through every state.
 *   set <state> Force a state manually (handy for testing).
 *   config      Print the statusLine snippet for ~/.claude/settings.json.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── State storage ──────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.tmpdir(), 'animax');
const CURRENT_FILE = path.join(STATE_DIR, 'current.json');
const STATES = ['idle', 'thinking', 'planning', 'coding', 'testing'];
const ACTIVE_HOLD_MS = 3000; // keep showing coding/testing/planning briefly after the tool finishes
const STALE_MS = 10 * 60 * 1000; // treat a non-idle state this old as idle (crashed session)

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

/** Which state to actually display, given the stored record and the clock. */
function effectiveState(rec, now = Date.now()) {
  if (!rec || !STATES.includes(rec.state)) return { state: 'idle', detail: '' };
  if (rec.state !== 'idle' && now - (rec.since || 0) > STALE_MS) return { state: 'idle', detail: '' };
  // Edits finish in milliseconds; without a hold, "coding" would only flash.
  if (rec.state === 'thinking' && rec.active && now - rec.active.at < ACTIVE_HOLD_MS) {
    return { state: rec.active.state, detail: rec.active.detail || '' };
  }
  return { state: rec.state, detail: rec.detail || '' };
}

// ─── Event classification ───────────────────────────────────────────────────

const PLAN_TOOLS = new Set(['TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate']);
const CODE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const TEST_RE = /\b(test|tests|spec|jest|vitest|mocha|ava|pytest|unittest|phpunit|rspec|go\s+test|cargo\s+(test|check|clippy)|lint|eslint|tsc|mypy|ruff|flake8|pyright|debug|gdb|lldb)\b/i;
const BUILD_RE = /\b(build|compile|make|cmake|install|npm\s+run|pnpm|yarn|cargo\s+build|go\s+build|gradle|mvn|dotnet\s+build|webpack|vite|esbuild)\b/i;

function shortPath(p) {
  return p ? path.basename(String(p)) : '';
}

function classifyTool(tool, input = {}) {
  if (PLAN_TOOLS.has(tool)) return { state: 'planning', detail: tool };
  if ((tool === 'Task' || tool === 'Agent') && /plan/i.test(input.subagent_type || '')) {
    return { state: 'planning', detail: 'Plan agent' };
  }
  if (CODE_TOOLS.has(tool)) {
    return { state: 'coding', detail: `${tool} ${shortPath(input.file_path || input.notebook_path)}`.trim() };
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command || '');
    const label = cmd.split(/\s+/).slice(0, 3).join(' ').slice(0, 40);
    if (TEST_RE.test(cmd)) return { state: 'testing', detail: label };
    if (BUILD_RE.test(cmd)) return { state: 'coding', detail: label };
    return { state: 'thinking', detail: label };
  }
  // Read, Grep, Glob, WebFetch, WebSearch, MCP tools… → analyzing.
  return { state: 'thinking', detail: tool ? `analyzing · ${tool}` : '' };
}

function classify(evt) {
  switch (evt.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'thinking', detail: 'reading prompt' };
    case 'PreToolUse': return classifyTool(evt.tool_name, evt.tool_input || {});
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
  if (prev && ['planning', 'coding', 'testing'].includes(prev.state)) {
    rec.active = { state: prev.state, detail: prev.detail, at: now };
  } else if (prev && prev.active && next.state === 'thinking') {
    rec.active = prev.active;
  }
  if (next.state !== 'thinking') delete rec.active;
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

// ─── Art ────────────────────────────────────────────────────────────────────
// Plain ASCII so it renders in every Windows/macOS/Linux terminal font.

const art = (s) => s.replace(/^\n/, '').replace(/\n$/, '').split('\n');

const FRAMES = {
  idle: [
    art(String.raw`

     .-----.
    ( -   - )    z
    (   _   )
     '-----'
      /   \
`),
    art(String.raw`
                   Z
     .-----.    z
    ( -   - )
    (   o   )
     '-----'
      /   \
`),
  ],

  thinking: [
    art(String.raw`
                    .
     .-----.
    ( o   o )
    (   ~   )
     '-----'
      /| |\
`),
    art(String.raw`
                  o  .
     .-----.
    (  o o  )
    (   ~   )
     '-----'
      /| |\
`),
    art(String.raw`
              .-----.
     .-----. ( hmm.. )
    ( o   o ) '-----'
    (   -   )
     '-----'
      /| |\
`),
    art(String.raw`
              .-----.
     .-----. (  ?!   )
    ( ^   ^ ) '-----'
    (   o   )
     '-----'   *
      /| |\
`),
  ],

  planning: [
    art(String.raw`
              +---------+
     .-----.  | [ ] ____|
    ( o   o ) | [ ] ____|
    (   _   )-| [ ] ____|
     '-----'  +---------+
      /| |\
`),
    art(String.raw`
              +---------+
     .-----.  | [x] ____|
    ( o   o ) | [ ] ____|
    (   _   )-| [ ] ____|
     '-----'  +---------+
      /| |\     /
`),
    art(String.raw`
              +---------+
     .-----.  | [x] ____|
    ( o   o ) | [x] ____|
    (   -   )-| [ ] ____|
     '-----'  +---------+
      /| |\      \
`),
    art(String.raw`
              +---------+
     .-----.  | [x] ____|
    ( ^   ^ ) | [x] ____|
    (   v   )-| [x] ____|
     '-----'  +---------+
      /| |\     done!
`),
  ],

  coding: [
    art(String.raw`
                 (   )
     .-----.      ) (
    ( ^   ^ )   _______
    (   o   )--|  </>  |
     '-----'   |_______|
      /| |\     ~~~~~
`),
    art(String.raw`
                  ) (
     .-----.     (   )
    ( ^   ^ )   _______
    (   o   )\ |  {;}  |
     '-----'  \|_______|
      /| |\     ~~~~~
`),
    art(String.raw`
                 (   )
     .-----.      ) (
    ( >   < )   _______
    (   O   )--|  ()=> |
     '-----'   |_______|
      /| |\    ~~~~~~~
`),
    art(String.raw`
                  ) (
     .-----.     (   )
    ( ^   ^ )   _______
    (   o   )/ |  [ ]  |
     '-----'  /|_______|
      /| |\     ~~~~~
`),
  ],

  testing: [
    art(String.raw`
                .--.
     .-----.   ( bug)
    ( o   O )---'--'
    (   _   )   PASS ..
     '-----'    FAIL
      /| |\
`),
    art(String.raw`
                   .--.
     .-----.      ( bug)
    ( O   o )------'--'
    (   _   )   PASS ..
     '-----'    FAIL x
      /| |\
`),
    art(String.raw`
                .--.
     .-----.   ( fix)
    ( >   < )---'--'
    (   ~   )   PASS ..
     '-----'    FAIL .
      /| |\
`),
    art(String.raw`
                .--.
     .-----.   ( ok )
    ( ^   ^ )---'--'
    (   v   )   PASS ok
     '-----'    FAIL 0
      /| |\
`),
  ],
};

// One-line variants for the status line.
const MINI = {
  idle: ['(-.-) z', '(-.-) zZ'],
  thinking: ['(o.o) .  ', '(o.o) .o ', '(o.o) .oO', '(^.^) ?! '],
  planning: ['(o.o)[   ]', '(o.o)[x  ]', '(o.o)[xx ]', '(^.^)[xxx]'],
  coding: ['(^.^)~[</>]', '(^.^) [{;}]~', '(>.<)~[()=>]', '(^.^) [ ;]~'],
  testing: ['(o.O)-o bug', '(O.o)--o bug', '(>.<)-o fix', '(^.^)-o ok!'],
};

const META = {
  idle: { label: 'idle', color: 90, fps: 2 },
  thinking: { label: 'thinking', color: 35, fps: 4 },
  planning: { label: 'planning', color: 34, fps: 3 },
  coding: { label: 'cooking code', color: 33, fps: 6 },
  testing: { label: 'debugging', color: 36, fps: 5 },
};

// ─── ANSI helpers ───────────────────────────────────────────────────────────

const USE_COLOR = !process.env.NO_COLOR;
const ESC = '\x1b[';
const paint = (code, s) => (USE_COLOR ? `${ESC}${code}m${s}${ESC}0m` : s);
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);

function frameFor(list, state, now = Date.now()) {
  const { fps } = META[state];
  return list[Math.floor(now / (1000 / fps)) % list.length];
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
  const m = META[state];
  const face = frameFor(MINI[state], state);
  const parts = [paint(m.color, face), paint(`1;${m.color}`, m.label)];
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
    const m = META[state];
    const lines = frameFor(FRAMES[state], state, now);
    const cols = out.columns || 80;
    const fit = (s) => (s.length > cols ? s.slice(0, cols) : s);

    let buf = `${ESC}H`; // home, then overwrite in place: no flicker, no scroll
    buf += `${fit(` ${bold('animax')} ${dim('· Ctrl+C to quit')}`)}${ESC}K\n${ESC}K\n`;
    for (const line of lines) buf += `${paint(m.color, fit('  ' + line))}${ESC}K\n`;
    buf += `${ESC}K\n`;
    buf += `  ${paint(`1;${m.color}`, m.label.toUpperCase())} ${dim(fit(detail || ''))}${ESC}K\n`;
    buf += `${ESC}J`; // clear anything left below from a taller previous frame
    out.write(buf);
  };

  tick();
  setInterval(tick, 100);
}

// ─── misc commands ──────────────────────────────────────────────────────────

function runSet(state) {
  if (!STATES.includes(state)) {
    console.error(`Unknown state "${state}". Use one of: ${STATES.join(', ')}`);
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(CURRENT_FILE, { state, detail: 'manual', since: Date.now() });
  console.log(`animax state → ${state}`);
}

function runConfig() {
  const script = path.resolve(__filename).replace(/\\/g, '/');
  const snippet = { statusLine: { type: 'command', command: `node "${script}" statusline`, padding: 0 } };
  console.log(JSON.stringify(snippet, null, 2));
}

function usage() {
  console.log(`animax — ASCII animations for Claude Code

Usage: node animator.js <command>

  hook          (used by hooks.json) read hook JSON on stdin, record state
  statusline    print one animated line for Claude Code's statusLine
  watch         full-size animation in this terminal (use a split pane)
  demo          cycle through all states
  set <state>   force a state: ${STATES.join(', ')}
  config        print the statusLine snippet for ~/.claude/settings.json

State dir: ${STATE_DIR}`);
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
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

module.exports = { classify, classifyTool, effectiveState, FRAMES, MINI };
