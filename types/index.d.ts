export type Ttl = { ms: number; isConfirmed: boolean }
// limit: the token count where auto-compaction runs (the window when it is off).
export type Context = { percent: number; tokens: number; window: number; limit: number }
export type Busy = 'handoff' | 'awty' | 'compact' | 'commit' | 'eli5' | null
// The confirm card open under the buttons, if any: one per action button.
export type Form = 'handoff' | 'compact' | 'commit' | 'grill' | 'eli5' | 'radio' | null
// An ELI5 explanation shown in a card on the strip.
export type Explained = { title: string; text: string }
// The resume prompt for the handoff just written, shown on the strip to copy.
export type ResumeNote = { name: string; text: string }
// What the session has cost, and what the last lap added.
export type Cost = { usd: number; lastLapUsd: number | null }
export type Laps = { count: number; lastMs: number | null; bestMs: number | null }
export type Trip = {
  goal: string
  progress: number
  status: string
  radio: string
  journey: string[]
  blockers: string[]
  questions: string[]
}

declare module 'claude-code' {
  interface PluginState {
    pitwall: {
      lastAt: number | null
      hit: number | null
      ttl: Ttl
      context: Context | null
      now: number
      busy: Busy
      trip: Trip | null
      isTripOpen: boolean
      touched: string[]
      resumable: string | null
      isSoundOn: boolean
      isLegendOpen: boolean
      laps: Laps
      burn: number[]
      cost: Cost | null
      isNotifyOn: boolean
      form: Form
      explained: Explained | null
      resumeNote: ResumeNote | null
      isCompacting: boolean
    }
  }
}
