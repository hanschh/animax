---
name: animax
description: Set up, preview, or troubleshoot the animax ASCII animations (thinking / planning / coding / testing) in Claude Code's terminal and VS Code chat. Use when the user asks to show or hide the animax pane, enable the animax status line or watch pane, run the demo, or asks why the animation is not showing.
---

# animax

animax shows an ASCII character that reacts to what Claude Code is doing:

| State      | Trigger                                                                           | Animation                      |
|------------|-----------------------------------------------------------------------------------|--------------------------------|
| `thinking` | a submitted prompt, a finished tool, Read/Grep/Glob/Web tools, plain shell commands | character with thought bubbles |
| `planning` | `TodoWrite`, `EnterPlanMode`/`ExitPlanMode`, the Plan subagent                    | ticking off a blueprint        |
| `coding`   | `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, build/install shell commands           | cooking code in a steaming pot |
| `testing`  | shell commands that match test/lint/typecheck/debug                               | hunting a bug with a magnifier |
| `idle`     | the turn ends                                                                     | sleeping                       |

## In the app (terminal and VS Code chat)

These come from `hooks/register.tsx`, a hooks module that runs inside Claude Code
2.1.32x or newer:

- **Terminal spinner**: while a turn runs, the pixel-bot video for the current
  state plays above Claude Code's own "Thinking…" line, or below it with
  `position: below`. The line itself is left untouched. The video is drawn as
  truecolor half blocks.
- **VS Code / desktop**: the spinner is left alone. The bot is drawn as an
  animated SVG in its own animax pane. The pane opens by itself, and after the
  user closes it, stays closed for that session.
- **`/animax`**: shows or hides the pane on any surface.
- **Sound**: each state's soundtrack loops while that state lasts. `/animax mute`
  and `/animax unmute` change the `sound` option, which is also in `/config`.
  On Windows the sound is played by PowerShell's `SoundPlayer`. On macOS it is
  played by `$.audio.play`.

The video frames come from `scripts/build-assets.mjs`. If
`assets/video.mjs` still holds `VIDEO = null`, the user has not built them yet.
Point them to `node scripts/build-assets.mjs`, which needs ffmpeg. Until they
build, animax shows ASCII art.

## Terminal fallbacks (any Claude Code version)

The command hooks in `hooks/hooks.json` write the state to `<os tmpdir>/animax/`.
`${CLAUDE_PLUGIN_ROOT}/scripts/animator.js` reads that state:

- **Status line**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/animator.js" config`
  and show the user the snippet. Ask before you merge it into
  `~/.claude/settings.json`. If a `statusLine` already exists, tell the user it
  will be replaced.
- **Watch pane**: in a second terminal, run `node <plugin>/scripts/animator.js watch`.
  It uses the alternate screen buffer, and Ctrl+C restores the terminal.
- **Demo**: `node <plugin>/scripts/animator.js demo` cycles through every state.

## Troubleshooting

- If the spinner shows no face, check that the plugin loaded and that the
  Claude Code version has hooks modules. Look for `animax` lines in
  `claude --debug`.
- If the watch pane does not change, check whether
  `<tmpdir>/animax/current.json` updates during a turn. If it does not, the
  command hooks are not running. Check `/hooks`, and check that `node` is on PATH.
- `NO_COLOR=1` turns off ANSI colours in the terminal animator.
