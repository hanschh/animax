export type CoreState = 'idle' | 'thinking' | 'planning' | 'coding' | 'testing'

export declare const STATES: CoreState[]
export declare const ACTIVE_STATES: CoreState[]
export declare const ACTIVE_HOLD_MS: number
export declare function classifyTool(
  tool: unknown,
  input?: Record<string, unknown>,
): { state: CoreState; detail: string }
export declare const FRAMES: Record<CoreState, string[][]>
export declare const MINI: Record<CoreState, string[]>
export declare const META: Record<
  CoreState,
  { label: string; ansi: number; color: string; fps: number }
>
export declare function pick<T>(list: readonly T[], n: number): T
