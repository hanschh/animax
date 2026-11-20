// animax in-app animation, for the terminal and the VS Code chat alike.
//
// - Terminal: the pixel-bot video of the current state is drawn above (or,
//   with `position: below`, under) Claude Code's own "Thinking…" line, which
//   is kept exactly as the engine draws it: a Raster of half-block cells.
// - VS Code / desktop: the spinner is left alone; the bot lives in its own
//   pane, opened by itself, as a self-animating SVG sprite.
// - /animax: shows or hides that pane (anywhere).
// - /animax mute | unmute: the soundtrack of each state, looped while it lasts.
// - /animax video <folder> | reset: the person's own character, built from
//   their videos into ~/.animax/video, in place of the built-in one.
//
// Without built assets (assets/video.mjs is null) it falls back to ASCII art.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import { VIDEO } from '../assets/video.mjs'
import type { VideoClip, VideoState } from '../assets/video.mjs'
import { ACTIVE_HOLD_MS, ACTIVE_STATES, FRAMES, META, MINI, classifyTool, pick } from '../scripts/core.mjs'
import { frameIndices, rasterCells } from '../scripts/pixels.mjs'
import type { AnimaxState, AnimaxStatus } from '../types'

const PANE = 'animax'
const AUDIO_SETTLE_MS = 400 // ignore states that flick past faster than this
const IDLE: AnimaxStatus = { state: 'idle', detail: '' }
const WIDGET_PX = 72 // editor height of the bot in a small widget seat
const PANE_PX = 96 // editor height of the bot in the pane

const status = atom({ plugin: 'animax', key: 'status' } as const, IDLE)
const frame = atom({ plugin: 'animax', key: 'frame' } as const, 0)
const isPaneOpen = atom({ plugin: 'animax', key: 'isPaneOpen' } as const, false)
const isWorking = atom({ plugin: 'animax', key: 'isWorking' } as const, false)
const isPaneDismissed = atom({ plugin: 'animax', key: 'isPaneDismissed' } as const, false)

type Options = { sound: boolean; position: 'above' | 'below' }

// Module variables start over on a hot reload; the atoms above do not.
let options: Options = { sound: true, position: 'above' }
let ticker: Timer | null = null
let generation = 0 // the newest status change; older timers stand down
let platform: string | null = null
let audioState: AnimaxState | null = null
let stopAudio: (() => void) | null = null
let paneHidden = false // the person closed the pane: no sound until it opens again
const SOUND_KEY = 'sound' // $.store: the last /animax mute (false) or unmute (true)
const cellCache = new Map<string, string>()

type Video = { fps: number; states: Partial<Record<VideoState, VideoClip>> }
let video: Video | null = VIDEO // the built-in clips, with the person's own over them
let customDir: string | null = null // ~/.animax/video, when its clips are in use
let customStates = new Set<string>() // the states drawn from customDir
let customSource = '' // the folder the person's videos came from

const tickMs = () => (video ? Math.round(1000 / video.fps) : 250)

// ─── state ──────────────────────────────────────────────────────────────────

async function setStatus($: EngineInterface, next: AnimaxStatus) {
  try {
    await update($, status, () => next)
  } catch {
    // decorative: never let a failed write disturb the turn
  }
  scheduleAudio($, next.state)
}

async function advanceFrame($: EngineInterface) {
  try {
    await update($, frame, n => (n + 1) % 1_000_000)
  } catch {
    // ignore
  }
}

/** Tick while a turn runs or the pane is open; stay silent otherwise. */
async function syncTicker($: EngineInterface) {
  const shouldTick = (await read($, isWorking)) || (await read($, isPaneOpen))
  if (shouldTick && !ticker) {
    ticker = $.clock.every(tickMs(), () => {
      void advanceFrame($)
    })
  } else if (!shouldTick && ticker) {
    ticker.cancel()
    ticker = null
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'animax' })
  await update($, isPaneOpen, () => true)
  await syncTicker($)
}

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await update($, isPaneOpen, () => false)
  await syncTicker($)
}

/** The person closed the pane: keep it closed and stop the sound with it. */
async function hidePane($: EngineInterface) {
  await update($, isPaneDismissed, () => true)
  paneHidden = true
  haltAudio()
}

const EDITOR_SURFACES: readonly string[] = ['vscode', 'desktop']

/** In the editor the bot lives in a pane: open it unless the person closed it. */
async function openForEditor($: EngineInterface) {
  try {
    const surfaces = await $.session.surfaces()
    if (!surfaces.some(s => EDITOR_SURFACES.includes(s))) return
    if ((await read($, isPaneOpen)) || (await read($, isPaneDismissed))) return
    await openPane($)
  } catch {
    // decorative
  }
}

/** After a tool: back to "analyzing", unless something newer happened. */
async function backToThinking($: EngineInterface, mine: number) {
  if (mine === generation && (await read($, isWorking))) {
    await setStatus($, { state: 'thinking', detail: 'analyzing result' })
  }
}

// ─── audio ──────────────────────────────────────────────────────────────────

function haltAudio() {
  try {
    stopAudio?.()
  } catch {
    // ignore
  }
  stopAudio = null
  audioState = null
}

/** Switch the soundtrack once a state has held for a moment. */
function scheduleAudio($: EngineInterface, state: AnimaxState) {
  const wanted: AnimaxState | null = options.sound && !paneHidden && state !== 'idle' ? state : null
  if (wanted === null) {
    haltAudio()
    return
  }
  if (wanted === audioState) return
  const mine = generation
  $.clock.after(AUDIO_SETTLE_MS, () => {
    if (mine === generation) void playAudio($, wanted)
  })
}

async function playAudio($: EngineInterface, state: AnimaxState) {
  const clip = video?.states[state]?.audio
  if (!clip || !options.sound || paneHidden || state === audioState) return
  haltAudio()
  audioState = state
  // The person's own clip lives outside the plugin; a built-in one is an asset.
  const own = customDir !== null && customStates.has(state)
  const base = own ? customDir! : $.plugin.root
  try {
    platform ??= (await $.session.info()).platform ?? 'unknown'
    if (platform === 'windows') {
      // $.audio.play has no player on a Windows terminal; SoundPlayer does.
      const file = `${base}\\${clip}`.replaceAll('/', '\\').replaceAll("'", "''")
      const script =
        `$p = New-Object System.Media.SoundPlayer '${file}'; $p.PlayLooping(); Start-Sleep -Seconds 3600`
      const child = $.process.spawn({
        argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
      })
      stopAudio = () => {
        // Ending the stream kills the child, and with it the sound.
        void child.return(undefined as never)
      }
      void drain(child)
    } else {
      const ctrl = new AbortController()
      stopAudio = () => ctrl.abort()
      const source = own
        ? { base64: (await $.fs.read(`${base}/${clip}`, { as: 'bytes' })).base64, mime: 'audio/wav' }
        : { asset: clip }
      if (ctrl.signal.aborted) return
      void $.audio.play(source, { shouldLoop: true, signal: ctrl.signal }).catch(() => undefined)
    }
  } catch {
    haltAudio()
  }
}

/** Keep the player's stream read so it lives until stopped. */
async function drain(stream: AsyncIterable<unknown>) {
  try {
    for await (const _ of stream) {
      // nothing to read; PowerShell prints nothing
    }
  } catch {
    // ended or killed
  }
}

// ─── drawing helpers ────────────────────────────────────────────────────────

function cellsFor(state: AnimaxState, clip: VideoClip, which: 'small' | 'large', n: number) {
  const frames = clip[which].frames
  const i = ((n % frames.length) + frames.length) % frames.length
  const key = `${state}:${which}:${i}`
  let cells = cellCache.get(key)
  if (cells === undefined) {
    const { w, h } = clip[which]
    cells = rasterCells(frameIndices(frames[i]!, w, h), w, h, clip.palette)
    cellCache.set(key, cells)
  }
  return cells
}

/** CSS size of the editor image: `height` tall, width by the clip's aspect. */
function editorSize(clip: VideoClip, height: number) {
  return { width: Math.round((height * clip.large.w) / clip.large.h), height }
}

// ─── the person's own character ─────────────────────────────────────────────

const READ_LIMIT = 4 * 1024 * 1024 // what one $.fs.read answers at most

/** ~/.animax/video: /animax video builds there, and the watch pane reads it too. */
async function customFolder($: EngineInterface) {
  return `${await homeFolder($)}/.animax/video`
}

async function homeFolder($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) throw new Error('no home folder (neither USERPROFILE nor HOME is set)')
  return home.replace(/[\\/]+$/, '')
}

/** A text file of any size, read in ranges (ASCII JSON: no character is cut). */
async function readText($: EngineInterface, file: string) {
  const { size } = await $.fs.stat(file)
  if (size <= READ_LIMIT) return (await $.fs.read(file)) as string
  let text = ''
  for (let offset = 0; offset < size; offset += READ_LIMIT) {
    text += (await $.fs.read(file, { offset, length: READ_LIMIT })) as string
  }
  return text
}

/**
 * Draw the clips in `dir` (its video.json) over the built-in ones, or only the
 * built-in ones when `dir` is null or holds none. Says whether `dir` was used.
 */
async function useCustom($: EngineInterface, dir: string | null) {
  let own: (Video & { source?: string }) | null = null
  if (dir) {
    try {
      const parsed = JSON.parse(await readText($, `${dir}/video.json`))
      if (parsed && typeof parsed === 'object' && parsed.states) own = parsed
    } catch {
      // none built, or reset: the built-in character
    }
  }
  const fps = video?.fps
  cellCache.clear()
  if (own) {
    video = { fps: own.fps || VIDEO?.fps || 8, states: { ...VIDEO?.states, ...own.states } }
    customDir = dir
    customStates = new Set(Object.keys(own.states))
    customSource = own.source ?? ''
  } else {
    video = VIDEO
    customDir = null
    customStates = new Set()
    customSource = ''
  }
  if (ticker && video?.fps !== fps) {
    ticker.cancel() // tick at the new clips' pace
    ticker = null
    await syncTicker($)
  }
  return own !== null
}

const VIDEO_HELP =
  'Use your own character: /animax video <folder> [--seconds=N]\n' +
  'The folder holds one video per state, the state in its name: idle, thinking, planning, ' +
  'coding (or cooking), testing. A state without a video keeps the built-in one. Needs ffmpeg.\n' +
  'Back to the built-in character: /animax video reset'

/** /animax video [<folder> [--seconds=N] | reset]: what it answers. */
async function runVideo($: EngineInterface, rest: string): Promise<string> {
  const secondsArg = rest.match(/(?:^|\s)--seconds=(\S+)/)
  const seconds = secondsArg ? Number(secondsArg[1]) : 8
  let folder = rest
    .replace(/(?:^|\s)--seconds=\S+/, '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')

  if (folder === '') {
    const now = customDir
      ? `animax character: your own${customSource ? `, from ${customSource}` : ''} (${[...customStates].join(', ')}).`
      : 'animax character: the built-in one.'
    return `${now}\n${VIDEO_HELP}`
  }

  const dir = await customFolder($)
  if (/^(reset|default|built-?in|off)$/i.test(folder)) {
    haltAudio()
    if (await $.fs.exists(`${dir}/video.json`)) await $.fs.write(`${dir}/video.json`, 'null')
    await useCustom($, null)
    await refresh($)
    return 'animax: back to the built-in character.'
  }

  if (!(seconds > 0 && seconds <= 30)) return 'animax: --seconds must be more than 0 and at most 30.'
  if (/^~(?=[\\/]|$)/.test(folder)) folder = (await homeFolder($)) + folder.slice(1)

  haltAudio() // Windows locks a WAV while it plays, and the build rewrites it
  let run
  try {
    run = await $.process.run(
      ['node', `${$.plugin.root}/scripts/build-assets.mjs`, folder, `--seconds=${seconds}`, `--out=${dir}`],
      { timeoutMs: 600_000 },
    )
  } catch (err) {
    return `animax: could not run node to build the video (${err instanceof Error ? err.message : String(err)}).`
  }
  if (run.exitCode !== 0) {
    const why = (run.stderr || run.stdout).trim().replace(/^animax build-assets: /, '')
    return `animax: could not build your character: ${why}\n${VIDEO_HELP}`
  }
  if (!(await useCustom($, dir))) return `animax: the build wrote nothing readable to ${dir}.`
  await refresh($)

  const picked = run.stdout
    .split(/\r?\n/)
    .filter(l => l.includes(' <- ') || l.startsWith('no video for'))
    .map(l => `  ${l.trim()}`)
  return [
    'animax: your character is in.',
    ...picked,
    `Previews: ${dir}/preview. Back to the built-in one: /animax video reset`,
  ].join('\n')
}

/** Draw again with the clips now in use. */
async function refresh($: EngineInterface) {
  try {
    await $.ui.invalidate('ui.render')
  } catch {
    // the next frame draws them anyway
  }
}

// ─── hooks ──────────────────────────────────────────────────────────────────

export const register: Register = (on, opts) => {
  const given = (opts ?? {}) as Partial<Options>
  options = {
    sound: given.sound !== false,
    position: given.position === 'below' ? 'below' : 'above',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'animax',
      description:
        'animax: show/hide the pane; "/animax mute" or "/animax unmute" for sound; "/animax video <folder>" for your own character',
    })
    paneHidden = await read($, isPaneDismissed) // module variables start over on a reload
    try {
      await useCustom($, await customFolder($)) // the person's own character, if built
    } catch {
      // the built-in one
    }
    // /animax mute or unmute, saved in an earlier session, wins over the setting.
    try {
      const saved = await $.store.get(SOUND_KEY)
      if (typeof saved === 'boolean') options = { ...options, sound: saved }
    } catch {
      // keep the setting's value
    }
    if (await read($, isPaneOpen)) await openPane($) // reopen after a reload
    else await openForEditor($)
    await syncTicker($) // keep animating if a reload landed mid-turn
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (EDITOR_SURFACES.includes(e.surface)) await openForEditor($)
    return result
  })

  on('session.end', async ($, e, next) => {
    haltAudio()
    return next(e)
  })

  on('command.run', { command: 'animax' }, async ($, e) => {
    const raw = (e.args ?? '').trim()
    const arg = raw.toLowerCase()
    const word = arg.split(/\s+/)[0]
    if (word === 'video') {
      try {
        return { text: await runVideo($, raw.slice(word.length).trim()) }
      } catch (err) {
        return { text: `animax video: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    if (arg === 'mute' || arg === 'unmute') {
      const sound = arg === 'unmute'
      // Apply it now, whatever happens to the saved choice.
      options = { ...options, sound }
      if (!sound) haltAudio()
      const text = sound ? 'animax sound on.' : 'animax muted.'
      // The plugin's own store keeps the choice on every surface. Not every
      // surface lists the plugin's /config rows, so that row is only a bonus.
      let problem: string | undefined
      try {
        await $.store.set(SOUND_KEY, sound)
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err)
      }
      try {
        const row = (await $.config.list()).find(r => /^animax(@[^.]+)?\.sound$/.test(r.key))
        if (row) await $.config.set({ key: row.key, value: sound })
      } catch {
        // the store already holds it
      }
      return { text: problem ? `${text} (Only for this session: could not save it: ${problem})` : text }
    }
    if (arg === 'sound') {
      return { text: `animax sound is ${options.sound ? 'on' : 'off'}. Use /animax mute or /animax unmute.` }
    }
    try {
      if (await read($, isPaneOpen)) {
        await closePane($)
        await hidePane($)
        return { text: 'animax pane closed.' }
      }
      await update($, isPaneDismissed, () => false)
      paneHidden = false // sound comes back with the next state change
      await openPane($)
      return { text: 'animax pane opened. Run /animax again to hide it.' }
    } catch (err) {
      return { text: `animax: could not toggle the pane (${err instanceof Error ? err.message : String(err)}).` }
    }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      if (e.origin.kind === 'person') await hidePane($)
      await update($, isPaneOpen, () => false)
      await syncTicker($)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    generation += 1
    await update($, isWorking, () => true)
    await setStatus($, { state: 'thinking', detail: 'reading prompt' })
    await openForEditor($)
    await syncTicker($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const mine = ++generation
    const found: AnimaxStatus = classifyTool(e.tool, e as unknown as Record<string, unknown>)
    await setStatus($, found)

    const result = await next(e)

    // Edits finish in milliseconds: hold planning/coding/testing a moment so
    // it can be seen, then go back to analyzing, unless something newer came.
    // Nothing here may throw: the tool has already run.
    try {
      if (ACTIVE_STATES.includes(found.state)) {
        $.clock.after(ACTIVE_HOLD_MS, () => {
          void backToThinking($, mine)
        })
      } else {
        await backToThinking($, mine)
      }
    } catch {
      // ignore
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    generation += 1
    await update($, isWorking, () => false)
    await setStatus($, IDLE)
    await syncTicker($)
    return next(e)
  })

  // The animation sits beside Claude Code's own spinner line, which is drawn
  // untouched by `next(e)`: word, ellipsis, timer and tokens all stay.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // Editors float a plugin's spinner tree as a card over the transcript, on
    // top of the engine's own line: there the bot lives in its pane instead.
    if (e.surface !== 'terminal') return next(e)
    const line = await next(e)
    const now = await read($, status)
    const state: AnimaxState = now.state === 'idle' ? 'thinking' : now.state
    const { Box, Text } = $.ui.resolve(e)
    const m = META[state]
    const clip = video?.states[state]

    let art
    if (clip && e.surface === 'terminal') {
      const { Raster } = $.ui.resolve({ ...e, surface: 'terminal' as const })
      const n = await read($, frame)
      art = (
        <Raster key="animax" columns={clip.small.w} rows={clip.small.h / 2} cells={cellsFor(state, clip, 'small', n)} />
      )
    } else {
      const n = await read($, frame)
      art = (
        <Text mono color={m.color}>
          {pick(MINI[state], n)}
        </Text>
      )
    }

    const block = (
      <Box flexDirection="row" gap={1} alignItems="center">
        {art}
        <Text color={m.color} dimColor>
          {m.label}
        </Text>
      </Box>
    )

    return options.position === 'below' ? (
      <Box flexDirection="column">
        {line}
        {block}
      </Box>
    ) : (
      <Box flexDirection="column">
        {block}
        {line}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, status)
    const m = META[now.state]
    const clip = video?.states[now.state]
    const isIdle = now.state === 'idle'

    // Bot on the left, what it is doing on the right: one short row.
    const side = (
      <Box flexDirection="column">
        <Text bold color={m.color}>
          {m.label.toUpperCase()}
        </Text>
        <Text dimColor>{isIdle ? 'waiting for your prompt' : now.detail}</Text>
      </Box>
    )
    const row = (art: RenderChildren) => (
      <Box flexDirection="row" alignItems="center" gap={2}>
        {art}
        {side}
      </Box>
    )

    if (clip && e.surface === 'terminal') {
      const { Raster } = $.ui.resolve({ ...e, surface: 'terminal' as const })
      const n = await read($, frame)
      return row(
        <Raster key="animax-pane" columns={clip.large.w} rows={clip.large.h / 2} cells={cellsFor(now.state, clip, 'large', n)} />,
      )
    }
    if (clip && e.surface !== 'mobile') {
      const { Svg } = $.ui.resolve({ ...e, surface: e.surface === 'desktop' ? 'desktop' : 'vscode' })
      const px = e.props.placement === 'widget' ? WIDGET_PX : PANE_PX
      return row(<Svg source={clip.svg} alt={`animax: ${m.label}`} {...editorSize(clip, px)} />)
    }

    // No assets, or a surface without images: ASCII art.
    const n = await read($, frame)
    if (e.props.placement === 'widget') {
      return (
        <Text mono color={m.color}>
          {pick(MINI[now.state], n)} {m.label}
        </Text>
      )
    }
    return row(
      <Box flexDirection="column">
        {pick(FRAMES[now.state], n).map((r: string) => (
          <Text mono color={m.color}>
            {r}
          </Text>
        ))}
      </Box>,
    )
  })
}
