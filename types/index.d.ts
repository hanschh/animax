export type AnimaxState = 'idle' | 'thinking' | 'planning' | 'coding' | 'testing'

export type AnimaxStatus = { state: AnimaxState; detail: string }

declare module 'claude-code' {
  interface PluginState {
    animax: {
      /** What Claude is doing now. */
      status: AnimaxStatus
      /** Animation tick; the terminal picks its video frame from this. */
      frame: number
      /** Whether the /animax pane is open. */
      isPaneOpen: boolean
      /** Whether a turn is running; kept here so a hot reload does not lose it. */
      isWorking: boolean
    }
  }
}
