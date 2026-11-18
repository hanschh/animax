---
name: animax
description: Set up, preview, or troubleshoot the animax ASCII terminal animations (thinking / planning / coding / testing). Use when the user asks to enable the animax status line, open the animation pane, run the demo, or asks why the animation is not showing.
---

# animax

animax shows an ASCII character that reacts to what Claude Code is doing:

| State      | Trigger (hook)                                                                 | Animation                       |
|------------|--------------------------------------------------------------------------------|---------------------------------|
| `thinking` | `UserPromptSubmit`, `PostToolUse`, Read/Grep/Glob/Web tools, plain shell commands | Character with thought bubbles  |
| `planning` | `TodoWrite`, `EnterPlanMode`/`ExitPlanMode`, Plan subagent                       | Ticking off a blueprint         |
| `coding`   | `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, build/install shell commands          | Cooking code in a steaming pot  |
| `testing`  | Shell commands that match test/lint/typecheck/debug                              | Hunting a bug with a magnifier  |
| `idle`     | `SessionStart`, `Stop`, `SessionEnd`                                             | Sleeping                        |

The hooks only write a small JSON state file to `<os tmpdir>/animax/`. They print
nothing, so Claude Code's own spinner text ("Thinking…", "Analyzing…",
"Flibbertigibbeting…") and the transcript are never touched. Rendering happens in
one of two places that Claude Code does not draw into.

The animator lives at `${CLAUDE_PLUGIN_ROOT}/scripts/animator.js`.

## Enable the one-line status line

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/animator.js" config` and show the user
   the printed snippet. It has the absolute path to the script.
2. Ask before you edit `~/.claude/settings.json`. Merge the `statusLine` key into
   that file. If the file already has a `statusLine`, keep the old value and tell
   the user that it will be replaced.
3. The status line updates whenever Claude Code refreshes it, for example on new
   messages and tool calls. Each refresh shows the next frame.

## Full-size animation in a side pane

Tell the user to open a second terminal next to Claude Code, for example a VS Code
split terminal, a Windows Terminal split pane (Alt+Shift+D), or a tmux pane. Then
run:

```
node "<plugin root>/scripts/animator.js" watch
```

This uses the alternate screen buffer and hides the cursor. Ctrl+C restores the
terminal. To preview every state without a live session, run `... animator.js demo`.

## Troubleshooting

- Check the current state with `node animator.js set thinking` (or another
  state) while `watch` is running. The pane should change within 100 ms.
- If nothing changes during a session, look at `<tmpdir>/animax/current.json`.
  If the file is missing, the hooks are not running. Check `/hooks` and confirm
  that `node` is on PATH.
- Set `NO_COLOR=1` to turn off ANSI colours.
