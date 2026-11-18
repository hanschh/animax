# animax

A pixel-bot shows what Claude Code is doing: **thinking**, **planning**, **coding**
(cooking code) or **testing** (debugging). Each state has its own video clip and
soundtrack. animax works in the terminal CLI and in the VS Code chat panel.

## What you see

- **Above the spinner line**: while Claude works, the bot for the current state
  plays just above Claude Code's own `Flibbertigibbeting… (12s · 1.2k tokens)`
  line. That line is left exactly as Claude Code draws it. In the terminal the
  bot is drawn with truecolor half blocks. In VS Code it is an animated image.
- **`/animax`**: shows or hides a pane with a larger bot.
- **Sound**: each state's soundtrack loops while that state lasts and stops when
  Claude finishes. `/animax mute` and `/animax unmute` turn it off and on.

## Settings (`/config`, or `pluginConfigs.animax.options` in settings.json)

| Option     | Values            | Default |
|------------|-------------------|---------|
| `sound`    | `true` / `false`  | `true`  |
| `position` | `above` / `below` | `above` |

## Build the video assets (once, and again after changing a video)

The plugin plays pre-converted frames, so it needs no ffmpeg at runtime. Building
them needs ffmpeg:

```
node scripts/build-assets.mjs            # reads ../video/pixel-bot-*.mp4
node scripts/build-assets.mjs --keep-bg  # keep the video background
```

Set `FFMPEG=C:\path\to\ffmpeg.exe` if ffmpeg is not on PATH. The script writes
`assets/video.mjs` and `assets/audio/*.wav`, plus previews in `build/preview/`.
Until it runs, animax shows ASCII art instead.

| State    | Video                        |
|----------|------------------------------|
| idle     | `pixel-bot-idle.mp4`         |
| thinking | `pixel-bot-thinking.mp4`     |
| planning | `pixel-bot-planning.mp4`     |
| coding   | `pixel-bot-cooking-code.mp4` |
| testing  | `pixel-bot-testing-code.mp4` |

## Load it

- **Terminal**: `claude --plugin-dir /path/to/animax`
- **VS Code chat (and terminal)**: add this to `~/.claude/settings.json`, then
  start a new chat:

  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "d:\\path\\to\\animax" } }
  ```

## Terminal extras (any Claude Code version)

```
node scripts/animator.js watch    # full-size bot in a split terminal
node scripts/animator.js demo     # cycle through every state
node scripts/animator.js config   # statusLine snippet for ~/.claude/settings.json
```

## Layout

| Path                       | Role                                                       |
|----------------------------|------------------------------------------------------------|
| `hooks/register.tsx`       | in-app animation, audio, `/animax`                         |
| `hooks/hooks.json`         | loads the module, plus command hooks for the terminal extras |
| `scripts/build-assets.mjs` | videos to frames, SVG sprites and WAV                      |
| `scripts/pixels.mjs`       | frames to terminal cells (Raster and ANSI)                 |
| `scripts/core.mjs`         | state detection and ASCII fallback                         |
| `scripts/animator.js`      | terminal extras: `hook`, `statusline`, `watch`, `demo`     |
| `tests/animax.test.tsx`    | `claude plugin test .`                                     |
