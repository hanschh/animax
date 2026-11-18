// Types for the generated assets/video.mjs (see scripts/build-assets.mjs).

export type VideoClip = {
  /** Plugin-relative path of the WAV soundtrack, or null when the video had none. */
  audio: string | null
  /** 0xRRGGBB colours; pixel index 0 is transparent, index n is palette[n - 1]. */
  palette: number[]
  /** Base64 of size*size palette indices per frame, row-major. */
  small: { size: number; frames: string[] }
  large: { size: number; frames: string[] }
  /** Self-animating SVG (sprite strip + CSS steps) for the editor surfaces. */
  svg: string
}

export type VideoState = 'idle' | 'thinking' | 'planning' | 'coding' | 'testing'

export declare const VIDEO: { fps: number; states: Record<VideoState, VideoClip> } | null
