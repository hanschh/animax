#!/usr/bin/env node
// animax asset builder: turns the pixel-bot videos into what the plugin draws.
//
//   node scripts/build-assets.mjs [videoDir] [--seconds=N] [--keep-bg] [--out=DIR] [--synthetic]
//
// videoDir    defaults to ../video next to the plugin folder
// --seconds=N how many seconds of each video to use (default 4)
// --keep-bg   keep the video's background instead of making it transparent
// --out=DIR   write a user's own character to DIR instead of the plugin's assets
// --synthetic write generated test frames (no ffmpeg, no audio), for tests
//
// Videos are found by name: the plugin's own names (pixel-bot-idle.mp4, ...)
// first, else any video whose name holds the state's word: idle, think, plan,
// cook or code, test or debug ("Slime - Testing code.mp4" is testing). With
// --out, a state with no video keeps the built-in character for that state.
//
// Needs ffmpeg: on PATH, or point FFMPEG at the executable.
//
// Writes, without --out:
//   assets/video.mjs          palette-indexed frames + an animated SVG per state
//   assets/audio/<state>.wav  each video's soundtrack (mono 22 kHz PCM)
//   build/preview/<state>.png contact sheet to eyeball the result
// With --out=DIR (what /animax video runs):
//   DIR/video.json, DIR/audio/<state>.wav, DIR/preview/<state>.png
//
// Run it again whenever a video changes. The plugin needs no ffmpeg to play it.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const VIDEO_DIR = path.resolve(args.find(a => !a.startsWith('--')) ?? path.join(ROOT, '..', 'video'))
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const OUT = args.find(a => a.startsWith('--out='))?.slice('--out='.length) || null

const FPS = 8
const SECONDS = Number(args.find(a => a.startsWith('--seconds='))?.split('=')[1] ?? 4)
if (!(SECONDS > 0)) throw new Error('--seconds must be a positive number')
const FRAMES = Math.round(FPS * SECONDS)
const SIZES = { small: 24, large: 48 } // pixels; the terminal shows 2 pixels per row
const WORK = 270 // decode size; the bot is found and cropped at this resolution
const PAD = 0.04 // margin kept around the bot, as a share of the crop
const MAX_COLORS = 63 // + index 0, which is "transparent"
const BG_TOLERANCE = 48 // RGB distance from the corner colour that counts as background
const SVG_LIMIT = 131072 // characters an Svg element accepts

// The plugin's own video names, one per state. pixel-bot-loops.mp4 (all
// states joined) is not used.
const SOURCES = {
  idle: 'pixel-bot-idle.mp4',
  thinking: 'pixel-bot-thinking.mp4',
  planning: 'pixel-bot-planning.mp4',
  coding: 'pixel-bot-cooking-code.mp4',
  testing: 'pixel-bot-testing-code.mp4',
}
const STATES = Object.keys(SOURCES)

// Any other name: the state's word in it. Testing goes before coding, so
// "testing code" is testing and "cooking code" is coding.
const WORDS = [
  ['idle', /idle/],
  ['thinking', /think/],
  ['planning', /plan/],
  ['testing', /test|debug/],
  ['coding', /cook|cod(e|ing)/],
]
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i

/** state -> video file in `dir`, for the states a video was found for. */
function findVideos(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`)
  const names = fs.readdirSync(dir).filter(n => VIDEO_EXT.test(n) && !/loops/i.test(n)).sort()
  const found = {}
  for (const [state, name] of Object.entries(SOURCES)) {
    if (names.includes(name)) found[state] = name
  }
  if (Object.keys(found).length === 0) {
    const taken = new Set()
    for (const [state, word] of WORDS) {
      const name = names.find(n => !taken.has(n) && word.test(n.toLowerCase()))
      if (name) {
        found[state] = name
        taken.add(name)
      }
    }
  }
  return Object.fromEntries(STATES.filter(s => found[s]).map(s => [s, path.join(dir, found[s])]))
}

// ─── decoding ───────────────────────────────────────────────────────────────

function ffmpeg(argv, what) {
  const run = spawnSync(FFMPEG, ['-v', 'error', ...argv], { maxBuffer: 256 * 1024 * 1024 })
  if (run.error) {
    throw new Error(`cannot run ffmpeg (${run.error.code}). Install it or set FFMPEG=path\\to\\ffmpeg.exe`)
  }
  if (run.status !== 0) throw new Error(`ffmpeg failed on ${what}: ${run.stderr.toString().trim()}`)
  return run.stdout
}

/** RGB frames of one video at `size`×`size`, area-averaged like a pixel artist would. */
function decode(file, size) {
  const raw = ffmpeg(
    ['-i', file, '-vf', `fps=${FPS},scale=${size}:${size}:flags=area`, '-frames:v', String(FRAMES),
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    path.basename(file),
  )
  const per = size * size * 3
  const frames = []
  for (let o = 0; o + per <= raw.length; o += per) frames.push(raw.subarray(o, o + per))
  if (frames.length === 0) throw new Error(`no frames decoded from ${file}`)
  return frames
}

function hasAudio(file) {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  return /Stream #.*Audio:/.test(run.stderr || '')
}

function extractAudio(file, out) {
  ffmpeg(['-y', '-i', file, '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', out], path.basename(file))
}

/** Test pattern: a bouncing square whose colour depends on the state. */
function synthetic(state, size) {
  const hue = { idle: [120, 120, 140], thinking: [200, 80, 220], planning: [70, 120, 240], coding: [240, 190, 40], testing: [40, 210, 210] }[state]
  const frames = []
  for (let f = 0; f < FRAMES; f++) {
    const buf = Buffer.alloc(size * size * 3)
    const s = Math.floor(size / 3)
    const x0 = Math.floor(((Math.sin((f / FRAMES) * Math.PI * 2) + 1) / 2) * (size - s))
    const y0 = Math.floor(size / 2 - s / 2)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3
        const inside = x >= x0 && x < x0 + s && y >= y0 && y < y0 + s
        const c = inside ? hue : [20, 20, 30] // background
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]
      }
    }
    frames.push(buf)
  }
  return frames
}

// ─── crop + scale ───────────────────────────────────────────────────────────

const isBg = (f, i, bg) =>
  bg !== null && (f[i] - bg[0]) ** 2 + (f[i + 1] - bg[1]) ** 2 + (f[i + 2] - bg[2]) ** 2 <= BG_TOLERANCE ** 2

/** Bounding box of every non-background pixel across `frames` (WORK×WORK). */
function contentBox(frames, bg, box) {
  for (const f of frames) {
    for (let y = 0; y < WORK; y++) {
      for (let x = 0; x < WORK; x++) {
        if (isBg(f, (y * WORK + x) * 3, bg)) continue
        if (x < box.x0) box.x0 = x
        if (x > box.x1) box.x1 = x
        if (y < box.y0) box.y0 = y
        if (y > box.y1) box.y1 = y
      }
    }
  }
  return box
}

/** The box with a margin, kept inside the frame (its own aspect, not square). */
function paddedBox(box) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1
  const pad = Math.ceil(Math.max(bw, bh) * PAD)
  const x = Math.max(0, box.x0 - pad), y = Math.max(0, box.y0 - pad)
  return { x, y, w: Math.min(WORK, box.x1 + 1 + pad) - x, h: Math.min(WORK, box.y1 + 1 + pad) - y }
}

/** Output width for a target height, keeping the crop's aspect. */
const widthFor = (rect, height) => Math.max(1, Math.round((height * rect.w) / rect.h))

/**
 * Crop `rect` out of a WORK×WORK frame and area-scale it to width×height. A
 * target pixel is background when most of its source pixels are; otherwise it
 * is the average of the bot's own pixels only, so edges get no background halo.
 */
function cropScale(f, rect, width, height, bg) {
  const out = Buffer.alloc(width * height * 3)
  const stepX = rect.w / width, stepY = rect.h / height
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const sx0 = Math.floor(rect.x + tx * stepX), sx1 = Math.max(sx0 + 1, Math.floor(rect.x + (tx + 1) * stepX))
      const sy0 = Math.floor(rect.y + ty * stepY), sy1 = Math.max(sy0 + 1, Math.floor(rect.y + (ty + 1) * stepY))
      let r = 0, g = 0, b = 0, n = 0, nBg = 0
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * WORK + x) * 3
          if (isBg(f, i, bg)) { nBg++; continue }
          r += f[i]; g += f[i + 1]; b += f[i + 2]; n++
        }
      }
      const o = (ty * width + tx) * 3
      if (n === 0 || nBg > n) {
        out[o] = bg ? bg[0] : 0; out[o + 1] = bg ? bg[1] : 0; out[o + 2] = bg ? bg[2] : 0
      } else {
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n)
      }
    }
  }
  return out
}

// ─── colour reduction ───────────────────────────────────────────────────────

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** The most common colour among the corner pixels of the first frame. */
function cornerColour(frame, size) {
  const counts = new Map()
  const k = Math.max(1, Math.floor(size / 8))
  for (const [cx, cy] of [[0, 0], [size - k, 0], [0, size - k], [size - k, size - k]]) {
    for (let y = cy; y < cy + k; y++) {
      for (let x = cx; x < cx + k; x++) {
        const i = (y * size + x) * 3
        const key = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2]
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255]
}

/** Popularity quantiser over 4-bit-per-channel buckets: palette of at most MAX_COLORS. */
function buildPalette(frameSets, bg) {
  const buckets = new Map()
  for (const frames of frameSets) {
    for (const f of frames) {
      for (let i = 0; i < f.length; i += 3) {
        const c = [f[i], f[i + 1], f[i + 2]]
        if (bg && dist2(c, bg) <= BG_TOLERANCE ** 2) continue
        const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4)
        const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
        b.n++; b.r += c[0]; b.g += c[1]; b.b += c[2]
        buckets.set(key, b)
      }
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_COLORS)
    .map(b => [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)])
}

function indexFrames(frames, palette, bg) {
  const cache = new Map()
  return frames.map(f => {
    const out = new Uint8Array(f.length / 3)
    for (let p = 0, i = 0; i < f.length; i += 3, p++) {
      const c = [f[i], f[i + 1], f[i + 2]]
      if (bg && dist2(c, bg) <= BG_TOLERANCE ** 2) { out[p] = 0; continue }
      const key = (c[0] << 16) | (c[1] << 8) | c[2]
      let best = cache.get(key)
      if (best === undefined) {
        best = 0
        let bestD = Infinity
        palette.forEach((q, j) => {
          const d = dist2(c, q)
          if (d < bestD) { bestD = d; best = j + 1 }
        })
        cache.set(key, best)
      }
      out[p] = best
    }
    return out
  })
}

/** Run-length encode bytes as [count, value] pairs, count 1..255. */
function rle(bytes) {
  const out = []
  for (let i = 0; i < bytes.length; ) {
    let n = 1
    while (n < 255 && i + n < bytes.length && bytes[i + n] === bytes[i]) n++
    out.push(n, bytes[i])
    i += n
  }
  return Buffer.from(out)
}

// ─── PNG + SVG ──────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Indexed PNG (colour type 3) with index 0 fully transparent. */
function encodePng(width, height, indices, palette) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const plte = Buffer.from([0, 0, 0, ...palette.flat()])
  const trns = Buffer.from([0]) // index 0 alpha 0; the rest default to opaque
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = indices[y * width + x]
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** All frames side by side in one strip. */
function strip(frames, width, height) {
  const w = width * frames.length
  const out = new Uint8Array(w * height)
  frames.forEach((f, n) => {
    for (let y = 0; y < height; y++) out.set(f.subarray(y * width, y * width + width), y * w + n * width)
  })
  return { width: w, height, indices: out }
}

/** A sprite strip slid by a stepped CSS animation: plays in the editor with no redraws. */
function animatedSvg(frames, width, height, palette, fps) {
  const s = strip(frames, width, height)
  const png = encodePng(s.width, s.height, s.indices, palette).toString('base64')
  const secs = (frames.length / fps).toFixed(3)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<style>@keyframes s{to{transform:translateX(-${s.width}px)}}` +
    `image{animation:s ${secs}s steps(${frames.length}) infinite;image-rendering:pixelated}</style>` +
    `<image width="${s.width}" height="${height}" href="data:image/png;base64,${png}"/></svg>`
  )
}

/** Contact sheet: 8 frames per row, each scaled 4× with a gap, for a quick look. */
function previewPng(frames, width, height, palette) {
  const cols = 8, scale = 4, gap = 8
  const cw = width * scale + gap, ch = height * scale + gap
  const rows = Math.ceil(frames.length / cols)
  const W = cols * cw, H = rows * ch
  const out = new Uint8Array(W * H)
  frames.forEach((f, n) => {
    const ox = (n % cols) * cw, oy = Math.floor(n / cols) * ch
    for (let y = 0; y < height * scale; y++) {
      for (let x = 0; x < width * scale; x++) {
        out[(oy + y) * W + ox + x] = f[Math.floor(y / scale) * width + Math.floor(x / scale)]
      }
    }
  })
  // Draw transparency as a checkerboard so it is visible in the preview.
  const pal = [...palette, [200, 200, 200], [150, 150, 150]]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (out[y * W + x] === 0) out[y * W + x] = ((x >> 3) + (y >> 3)) % 2 ? pal.length - 1 : pal.length
    }
  }
  return encodePng(W, H, out, pal)
}

// ─── main ───────────────────────────────────────────────────────────────────

function main() {
  const isSynthetic = flags.has('--synthetic')
  const keepBg = flags.has('--keep-bg')
  const outDir = OUT ? path.resolve(OUT) : null
  const audioDir = outDir ? path.join(outDir, 'audio') : path.join(ROOT, 'assets', 'audio')
  const audioRef = outDir ? 'audio' : 'assets/audio' // how the output names a WAV
  const previewDir = outDir ? path.join(outDir, 'preview') : path.join(ROOT, 'build', 'preview')

  const sources = isSynthetic ? Object.fromEntries(STATES.map(s => [s, null])) : findVideos(VIDEO_DIR)
  const found = Object.keys(sources)
  if (found.length === 0) {
    throw new Error(
      `no videos found in ${VIDEO_DIR}. Put the state in each file name: idle, thinking, planning, coding (or cooking), testing`,
    )
  }
  const missing = STATES.filter(s => !found.includes(s))
  if (missing.length && !outDir) {
    throw new Error(`the plugin's own assets need all five videos; missing: ${missing.join(', ')}`)
  }
  for (const state of found) {
    console.log(`${state.padEnd(9)} <- ${sources[state] ? path.basename(sources[state]) : 'synthetic'}`)
  }
  if (missing.length) console.log(`no video for: ${missing.join(', ')} (the built-in character stays there)`)
  console.log('')

  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(previewDir, { recursive: true })

  // Pass 1: decode every video and find one crop that holds the bot in all of
  // them, so it keeps its size and place when the state changes.
  const work = {}
  const box = { x0: WORK, y0: WORK, x1: -1, y1: -1 }
  for (const state of found) {
    const src = sources[state]
    const frames = isSynthetic ? synthetic(state, WORK) : decode(src, WORK)
    const bg = cornerColour(frames[0], WORK)
    work[state] = { src, frames, bg }
    contentBox(frames, bg, box)
  }
  const rect = box.x1 < 0 ? { x: 0, y: 0, w: WORK, h: WORK } : paddedBox(box)
  const dims = Object.fromEntries(
    Object.entries(SIZES).map(([k, h]) => [k, { w: widthFor(rect, h), h }]),
  )
  console.log(
    `crop: ${rect.w}x${rect.h} at (${rect.x},${rect.y}) of ${WORK}x${WORK}; ` +
      `small ${dims.small.w}x${dims.small.h}, large ${dims.large.w}x${dims.large.h} px\n`,
  )

  // Pass 2: crop, scale, reduce colours, encode.
  const states = {}
  for (const state of found) {
    const { src, frames, bg: corner } = work[state]
    const rgb = {}
    for (const [k, d] of Object.entries(dims)) rgb[k] = frames.map(f => cropScale(f, rect, d.w, d.h, corner))

    const bg = keepBg ? null : corner
    const palette = buildPalette([rgb.small, rgb.large], bg)
    const idx = {
      small: indexFrames(rgb.small, palette, bg),
      large: indexFrames(rgb.large, palette, bg),
    }

    // Keep the SVG under the element's limit by dropping every other frame if needed.
    let svgFrames = idx.large, svgFps = FPS
    let svg = animatedSvg(svgFrames, dims.large.w, dims.large.h, palette, svgFps)
    while (svg.length > SVG_LIMIT && svgFrames.length > 2) {
      svgFrames = svgFrames.filter((_, i) => i % 2 === 0)
      svgFps /= 2
      svg = animatedSvg(svgFrames, dims.large.w, dims.large.h, palette, svgFps)
    }

    let audio = null
    const wav = path.join(audioDir, `${state}.wav`)
    if (!isSynthetic && hasAudio(src)) {
      extractAudio(src, wav)
      audio = `${audioRef}/${state}.wav`
    } else if (fs.existsSync(wav)) {
      fs.unlinkSync(wav)
    }

    fs.writeFileSync(path.join(previewDir, `${state}.png`), previewPng(idx.large, dims.large.w, dims.large.h, palette))

    const pack = k => ({ ...dims[k], frames: idx[k].map(f => rle(f).toString('base64')) })
    states[state] = {
      audio,
      palette: palette.map(([r, g, b]) => (r << 16) | (g << 8) | b),
      small: pack('small'),
      large: pack('large'),
      svg,
    }
    console.log(
      `${state.padEnd(9)} ${idx.large.length} frames, ${palette.length} colours, ` +
        `bg ${bg ? `rgb(${bg.join(',')}) -> transparent` : 'kept'}, svg ${(svg.length / 1024).toFixed(0)} KB` +
        `${svgFrames.length < idx.large.length ? ` (${svgFrames.length} frames)` : ''}, audio ${audio ? 'yes' : 'no'}`,
    )
  }

  // A state without a video of its own drops an old WAV too.
  for (const state of missing) {
    const wav = path.join(audioDir, `${state}.wav`)
    if (fs.existsSync(wav)) fs.unlinkSync(wav)
  }

  let out
  if (outDir) {
    out = path.join(outDir, 'video.json')
    fs.writeFileSync(out, JSON.stringify({ fps: FPS, source: path.resolve(VIDEO_DIR), states }))
  } else {
    const header =
      '// Generated by scripts/build-assets.mjs. Do not edit; run the script again.\n' +
      `// Source: ${isSynthetic ? 'synthetic test pattern' : `${path.basename(path.resolve(VIDEO_DIR))} videos`}\n`
    out = path.join(ROOT, 'assets', 'video.mjs')
    fs.writeFileSync(out, header + `export const VIDEO = ${JSON.stringify({ fps: FPS, states })}\n`)
  }
  console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
  console.log(`previews in ${previewDir}`)
}

try {
  main()
} catch (err) {
  console.error(`animax build-assets: ${err.message}`)
  process.exit(1)
}
