// animax core: state classification and ASCII art.
// Pure data and functions, no Node and no DOM, so both the in-app hooks module
// (hooks/register.tsx) and the terminal animator (scripts/animator.js) share it.

export const STATES = ['idle', 'thinking', 'planning', 'coding', 'testing']
export const ACTIVE_STATES = ['planning', 'coding', 'testing']

/** How long planning/coding/testing stays on screen after its tool finishes. */
export const ACTIVE_HOLD_MS = 3000

const PLAN_TOOLS = new Set(['TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate'])
const CODE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const TEST_RE = /\b(test|tests|spec|jest|vitest|mocha|ava|pytest|unittest|phpunit|rspec|go\s+test|cargo\s+(test|check|clippy)|lint|eslint|tsc|mypy|ruff|flake8|pyright|debug|gdb|lldb)\b/i
const BUILD_RE = /\b(build|compile|make|cmake|install|npm\s+run|pnpm|yarn|cargo\s+build|go\s+build|gradle|mvn|dotnet\s+build|webpack|vite|esbuild)\b/i

function baseName(p) {
  return p ? String(p).split(/[\\/]/).pop() : ''
}

/**
 * Map a tool call to a state. `input` holds the tool's arguments
 * (`file_path`, `command`, `subagent_type`, ...).
 * @returns {{ state: string, detail: string }}
 */
export function classifyTool(tool, input = {}) {
  tool = String(tool || '')
  if (PLAN_TOOLS.has(tool)) return { state: 'planning', detail: tool }
  if ((tool === 'Task' || tool === 'Agent') && /plan/i.test(String(input.subagent_type || ''))) {
    return { state: 'planning', detail: 'Plan agent' }
  }
  if (CODE_TOOLS.has(tool)) {
    return { state: 'coding', detail: `${tool} ${baseName(input.file_path || input.notebook_path)}`.trim() }
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command || '')
    const label = cmd.trim().split(/\s+/).slice(0, 3).join(' ').slice(0, 40)
    if (TEST_RE.test(cmd)) return { state: 'testing', detail: label }
    if (BUILD_RE.test(cmd)) return { state: 'coding', detail: label }
    return { state: 'thinking', detail: label }
  }
  // Read, Grep, Glob, WebFetch, WebSearch, MCP tools... count as analyzing.
  return { state: 'thinking', detail: tool ? `analyzing · ${tool}` : '' }
}

// ─── Art ────────────────────────────────────────────────────────────────────
// Plain ASCII, so it renders in every terminal font and in the editor.

const art = s => s.replace(/^\n/, '').replace(/\n$/, '').split('\n')

export const FRAMES = {
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
}

/** One-line variants for the spinner suffix and the status line. */
export const MINI = {
  idle: ['(-.-) z', '(-.-) zZ'],
  thinking: ['(o.o) .  ', '(o.o) .o ', '(o.o) .oO', '(^.^) ?! '],
  planning: ['(o.o)[   ]', '(o.o)[x  ]', '(o.o)[xx ]', '(^.^)[xxx]'],
  coding: ['(^.^)~[</>]', '(^.^) [{;}]~', '(>.<)~[()=>]', '(^.^) [ ;]~'],
  testing: ['(o.O)-o bug', '(O.o)--o bug', '(>.<)-o fix', '(^.^)-o ok!'],
}

/** Label, ANSI colour code (terminal animator) and colour name (in-app). */
export const META = {
  idle: { label: 'idle', ansi: 90, color: 'gray', fps: 2 },
  thinking: { label: 'thinking', ansi: 35, color: 'magenta', fps: 4 },
  planning: { label: 'planning', ansi: 34, color: 'blue', fps: 3 },
  coding: { label: 'cooking code', ansi: 33, color: 'yellow', fps: 6 },
  testing: { label: 'debugging', ansi: 36, color: 'cyan', fps: 5 },
}

/** Frame `n` of a list, wrapping around. */
export function pick(list, n) {
  return list[((n % list.length) + list.length) % list.length]
}
