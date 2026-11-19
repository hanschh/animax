<p align="center">
  <img src="assets/icon.svg" alt="animax pixel-bot cooking code" width="120" style="image-rendering: pixelated">
</p>

# animax

A pixel-bot shows what Claude Code is doing: **thinking**, **planning**, **coding**
(cooking code) or **testing** (debugging). Each state has its own video clip and
soundtrack. animax works in the terminal CLI and in the VS Code chat panel.

## What you see

- **Terminal**: while Claude works, the bot for the current state plays just
  above Claude Code's own `Flibbertigibbeting… (12s · 1.2k tokens)` line. That
  line is left exactly as Claude Code draws it. The bot is drawn with truecolor
  half blocks.
- **VS Code chat**: the spinner line is left alone. The bot gets its own
  animax panel, which opens by itself, so it never covers the chat.
- **`/animax`**: shows or hides the panel, in the terminal or the editor. If you
  close the panel, it stays closed for that session until you run `/animax`.
- **Sound**: each state's soundtrack loops while that state lasts and stops when
  Claude finishes. `/animax mute` and `/animax unmute` turn it off and on.

## Settings (`/config`, or `pluginConfigs.animax.options` in settings.json)

| Option     | Values            | Default | Applies to            |
| ---------- | ----------------- | ------- | --------------------- |
| `sound`    | `true` / `false`  | `true`  | terminal and VS Code  |
| `position` | `above` / `below` | `above` | terminal only         |

- **`sound`**: plays each state's soundtrack, in the terminal and in VS Code
  chat. `/animax mute` and `/animax unmute` change it from either one, and the
  choice is saved for both.
- **`position`**: puts the bot above or below the `Thinking…` line. Only the
  terminal shows that line. In VS Code chat the bot is always in its own
  animax panel, so this option changes nothing there.

To turn sound off in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "animax": { "options": { "sound": false } } } }
```

## Build the video assets (once, and again after changing a video)

The plugin plays pre-converted frames, so it needs no ffmpeg at runtime. Building
them needs ffmpeg:

```
node scripts/build-assets.mjs            # reads ../video/pixel-bot-*.mp4
node scripts/build-assets.mjs --keep-bg  # keep the video background
node scripts/build-assets.mjs ../video/8sec-build --seconds=8  # other folder, longer clips
```

`--seconds=N` sets how much of each video is used (default 4, at 8 fps). The
files in the folder must be named as in the table below.

Set `FFMPEG=C:\path\to\ffmpeg.exe` if ffmpeg is not on PATH. The script writes
`assets/video.mjs` and `assets/audio/*.wav`, plus previews in `build/preview/`.
Until it runs, animax shows ASCII art instead.

| State    | Video                        |
| -------- | ---------------------------- |
| idle     | `pixel-bot-idle.mp4`         |
| thinking | `pixel-bot-thinking.mp4`     |
| planning | `pixel-bot-planning.mp4`     |
| coding   | `pixel-bot-cooking-code.mp4` |
| testing  | `pixel-bot-testing-code.mp4` |

## Install

Run these in a normal shell (PowerShell, cmd, bash, zsh). They work for both
the terminal CLI and the VS Code chat panel:

```
claude plugin marketplace add hanschh/animax
claude plugin install animax@hanschh
```

Or, inside an interactive `claude` session in the terminal:

```
/plugin marketplace add hanschh/animax
/plugin install animax@hanschh
```

> `/plugin` only works inside an interactive `claude` session in the terminal.
> The VS Code chat panel replies "/plugin isn't available in this environment",
> and typing `/plugin` straight into PowerShell fails because it is not a shell
> command. Use the `claude plugin …` form above in those cases.

Claude Code downloads the plugin itself, so there is no path to set. Start a
new chat (or reload the VS Code window) afterwards.

### Update or remove

```
claude plugin marketplace update hanschh
claude plugin update animax@hanschh
claude plugin uninstall animax@hanschh
```

## Development (load from a local clone)

Only for working on animax itself. Replace the path with wherever you cloned
the repo, on any drive or OS.

- **Terminal**: `claude --plugin-dir /path/to/animax`
- **VS Code chat (and terminal)**: add this to `~/.claude/settings.json`, then
  start a new chat:

  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/animax" } }
  ```

  On Windows, escape the backslashes, e.g. `"C:\\Users\\you\\animax"`.

## Terminal extras (any Claude Code version)

```
node scripts/animator.js watch    # full-size bot in a split terminal
node scripts/animator.js demo     # cycle through every state
node scripts/animator.js config   # statusLine snippet for ~/.claude/settings.json
```

## Layout

| Path                       | Role                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `hooks/register.tsx`       | in-app animation, audio, `/animax`                           |
| `hooks/hooks.json`         | loads the module, plus command hooks for the terminal extras |
| `scripts/build-assets.mjs` | videos to frames, SVG sprites and WAV                        |
| `scripts/pixels.mjs`       | frames to terminal cells (Raster and ANSI)                   |
| `scripts/core.mjs`         | state detection and ASCII fallback                           |
| `scripts/animator.js`      | terminal extras: `hook`, `statusline`, `watch`, `demo`       |
| `tests/animax.test.tsx`    | `claude plugin test .`                                       |

## Author

Made by [hanschh](https://github.com/hanschh). The pixel-bot art and sounds are
part of this project.

Source: <https://github.com/hanschh/animax>

## License

[MIT](LICENSE) © 2026 hanschh. You may use, change and share animax. Every copy,
or substantial part of it, must keep the copyright line and the license text.
