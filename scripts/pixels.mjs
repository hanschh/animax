// animax pixels: palette-indexed frames to terminal cells. No Node, no DOM, so
// both the hooks module and the terminal animator can use it.
//
// Two pixels share one terminal cell: the upper half block U+2580 painted with
// the top pixel as foreground and the bottom pixel as background.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

export function fromBase64(s) {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64_INDEX.get(clean[i]) << 18) |
      ((B64_INDEX.get(clean[i + 1]) ?? 0) << 12) |
      ((B64_INDEX.get(clean[i + 2]) ?? 0) << 6) |
      (B64_INDEX.get(clean[i + 3]) ?? 0)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

export function toBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    s += b === undefined ? '=' : B64[(n >> 6) & 63]
    s += c === undefined ? '=' : B64[n & 63]
  }
  return s
}

/** Run-length decode [count, value] pairs (count 1..255) into `length` bytes. */
export function unrle(packed, length) {
  const out = new Uint8Array(length)
  let o = 0
  for (let i = 0; i + 1 < packed.length && o < length; i += 2) {
    const end = Math.min(length, o + packed[i])
    out.fill(packed[i + 1], o, end)
    o = end
  }
  return out
}

/** A stored frame (base64 of RLE pairs) back to w*h palette indices. */
export function frameIndices(stored, width, height) {
  return unrle(fromBase64(stored), width * height)
}

const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20
const DEFAULT = 0x01000000 // the terminal's own colour (Raster encoding)

/**
 * One frame as cell triplets [codePoint, fg, bg], `width` columns by height/2 rows.
 * Transparent pixels (index 0) take the terminal's default colour.
 */
export function frameCells(indices, width, height, palette) {
  const rows = height >> 1
  const out = new Uint32Array(width * rows * 3)
  const col = i => (i === 0 ? DEFAULT : palette[i - 1])
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < width; c++) {
      const top = indices[2 * r * width + c]
      const bot = indices[(2 * r + 1) * width + c]
      const o = (r * width + c) * 3
      if (top === 0 && bot === 0) {
        out[o] = SPACE; out[o + 1] = DEFAULT; out[o + 2] = DEFAULT
      } else if (top === 0) {
        out[o] = LOWER; out[o + 1] = col(bot); out[o + 2] = DEFAULT
      } else {
        out[o] = UPPER; out[o + 1] = col(top); out[o + 2] = col(bot)
      }
    }
  }
  return out
}

/** Raster `cells`: little-endian u32 triplets, base64. */
export function rasterCells(indices, width, height, palette) {
  const words = frameCells(indices, width, height, palette)
  const bytes = new Uint8Array(words.length * 4)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    bytes[i * 4] = w & 255
    bytes[i * 4 + 1] = (w >>> 8) & 255
    bytes[i * 4 + 2] = (w >>> 16) & 255
    bytes[i * 4 + 3] = (w >>> 24) & 255
  }
  return toBase64(bytes)
}

/** The same frame as ANSI truecolor lines, for a plain terminal. */
export function ansiLines(indices, width, height, palette) {
  const words = frameCells(indices, width, height, palette)
  const lines = []
  const rgb = v => `${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`
  for (let r = 0; r < height >> 1; r++) {
    let line = ''
    let lastFg = -1, lastBg = -1 // emit a colour only when it changes
    for (let c = 0; c < width; c++) {
      const o = (r * width + c) * 3
      const [cp, fg, bg] = [words[o], words[o + 1], words[o + 2]]
      if (fg !== lastFg) line += fg === DEFAULT ? '\x1b[39m' : `\x1b[38;2;${rgb(fg)}m`
      if (bg !== lastBg) line += bg === DEFAULT ? '\x1b[49m' : `\x1b[48;2;${rgb(bg)}m`
      lastFg = fg; lastBg = bg
      line += String.fromCharCode(cp)
    }
    lines.push(line + '\x1b[0m')
  }
  return lines
}
