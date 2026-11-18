// animax in-app animation, for the terminal and the VS Code chat alike.
//
// - Terminal: the pixel-bot video of the current state is drawn above (or,
//   with `position: below`, under) Claude Code's own "Thinking…" line, which
//   is kept exactly as the engine draws it: a Raster of half-block cells.
// - VS Code / desktop: the spinner is left alone; the bot lives in its own
//   pane, opened by itself, as a self-animating SVG sprite.
// - /animax: shows or hides that pane (anywhere).
// - /animax mute | unmute: the soundtrack of each state, looped while it lasts.
//
// Without built assets (assets/video.mjs is null) it falls back to ASCII art.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import { VIDEO } from '../assets/video.mjs'
import type { VideoClip } from '../assets/video.mjs'
import { ACTIVE_HOLD_MS, ACTIVE_STATES, FRAMES, META, MINI, classifyTool, pick } from '../scripts/core.mjs'
import { frameIndices, rasterCells } from '../scripts/pixels.mjs'
import type { AnimaxState, AnimaxStatus } from '../types'

const PANE = 'animax'
const TICK_MS = VIDEO ? Math.round(1000 / VIDEO.fps) : 250
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
const cellCache = new Map<string, string>()

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
    ticker = $.clock.every(TICK_MS, () => {
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
  const wanted: AnimaxState | null = options.sound && state !== 'idle' ? state : null
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
  const clip = VIDEO?.states[state]?.audio
  if (!clip || !options.sound || state === audioState) return
  haltAudio()
  audioState = state
  try {
    platform ??= (await $.session.info()).platform ?? 'unknown'
    if (platform === 'windows') {
      // $.audio.play has no player on a Windows terminal; SoundPlayer does.
      const file = `${$.plugin.root}\\${clip.replaceAll('/', '\\')}`.replaceAll("'", "''")
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
      void $.audio.play({ asset: clip }, { shouldLoop: true, signal: ctrl.signal }).catch(() => undefined)
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
      description: 'animax: show/hide the pane; "/animax mute" or "/animax unmute" for sound',
    })
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
    const arg = e.args.trim().toLowerCase()
    if (arg === 'mute' || arg === 'unmute') {
      const sound = arg === 'unmute'
      const { deny } = await $.config.set({ key: 'animax.sound', value: sound })
      if (deny) return { text: `animax: could not change the sound setting (${deny}).` }
      options = { ...options, sound } // the reload that follows reads it too
      if (!sound) haltAudio()
      return { text: sound ? 'animax sound on.' : 'animax muted.' }
    }
    if (arg === 'sound') {
      return { text: `animax sound is ${options.sound ? 'on' : 'off'}. Use /animax mute or /animax unmute.` }
    }
    if (await read($, isPaneOpen)) {
      await closePane($)
      await update($, isPaneDismissed, () => true)
      return { text: 'animax pane closed.' }
    }
    await update($, isPaneDismissed, () => false)
    await openPane($)
    return { text: 'animax pane opened. Run /animax again to hide it.' }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      if (e.origin.kind === 'person') await update($, isPaneDismissed, () => true)
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
    const clip = VIDEO?.states[state]

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
    const clip = VIDEO?.states[now.state]
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
