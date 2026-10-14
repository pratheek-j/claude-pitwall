import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Busy, Context, Cost, Explained, Form, Laps, ResumeNote, Trip, Ttl } from '../types'

type Engine = EngineInterface
type Level = 'ok' | 'warn' | 'hot'

const MIN = 60_000
const FIVE_MIN = 5 * MIN
const HOUR = 60 * MIN

const lastAt = atom({ plugin: 'pitwall', key: 'lastAt' } as const, null)
const hit = atom({ plugin: 'pitwall', key: 'hit' } as const, null)
const ttl = atom({ plugin: 'pitwall', key: 'ttl' } as const, { ms: HOUR, isConfirmed: false })
const context = atom({ plugin: 'pitwall', key: 'context' } as const, null)
const now = atom({ plugin: 'pitwall', key: 'now' } as const, 0)
const busy = atom({ plugin: 'pitwall', key: 'busy' } as const, null)
const trip = atom({ plugin: 'pitwall', key: 'trip' } as const, null)
const isTripOpen = atom({ plugin: 'pitwall', key: 'isTripOpen' } as const, false)
const touched = atom({ plugin: 'pitwall', key: 'touched' } as const, [])
const resumable = atom({ plugin: 'pitwall', key: 'resumable' } as const, null)
const isSoundOn = atom({ plugin: 'pitwall', key: 'isSoundOn' } as const, true)
const isLegendOpen = atom({ plugin: 'pitwall', key: 'isLegendOpen' } as const, false)
const laps = atom({ plugin: 'pitwall', key: 'laps' } as const, { count: 0, lastMs: null, bestMs: null })
// Context tokens each recent turn added: how fast the context fills per lap.
const burn = atom({ plugin: 'pitwall', key: 'burn' } as const, [])
const cost = atom({ plugin: 'pitwall', key: 'cost' } as const, null)
const isNotifyOn = atom({ plugin: 'pitwall', key: 'isNotifyOn' } as const, true)
const form = atom({ plugin: 'pitwall', key: 'form' } as const, null)
const explained = atom({ plugin: 'pitwall', key: 'explained' } as const, null)
const resumeNote = atom({ plugin: 'pitwall', key: 'resumeNote' } as const, null)
// True while the main conversation is being compacted, however it was started.
const isCompacting = atom({ plugin: 'pitwall', key: 'isCompacting' } as const, false)

// Theme keys on the terminal follow the person's color theme; the SVG bars need hex.
const THEME: Record<Level, string> = { ok: 'success', warn: 'warning', hot: 'error' }
const HEX: Record<Level, string> = { ok: '#22c55e', warn: '#f5c518', hot: '#e10600' }
const PURPLE = '#a855f7'

// Ferrari livery: Rosso Corsa and yellow. Gauges keep green/yellow/red for meaning.
const RED = '#dc0000'
const YELLOW = '#fff200'

// Plain-English meaning of every racing name, for the hover cards and the legend.
const TIPS = {
  cache: 'Prompt cache: time until it expires (TTL 1h or 5m, ? = not confirmed yet). Hit = share of the last turn read from cache. Striped end = last 5 min.',
  context: 'How full the context is, measured to where it auto-compacts. Laps = turns left at your recent rate. White marks = the 70% and 85% warnings; striped end = the last 15%.',
  race: 'Progress toward the goal, from your last Radio check.',
  lap: 'One lap = one answered turn. Purple = your fastest turn yet.',
  flag: 'Worst of cache and context: green fine, yellow watch it, red act now.',
  handoff: 'Writes a detailed file to .handoff/ (git-ignored) so a new session can pick up from here. ✏️ With a focus… puts /handoff in the prompt box to tailor it. The resume prompt then shows here, ready to copy.',
  grill: 'Runs the mattpocock grilling skill on the current plan, or ✏️ on a topic you type in the prompt box: Claude interviews you, round by round, until it holds up.',
  eli5: 'Explains the last answer, or the whole session, like you are 5: plain words, an analogy, tiny examples.',
  compact: 'Summarizes the conversation to free up context. Only between turns.',
  radio: 'Are we there yet?: summary, progress, and 3 questions you could ask next.',
  commit: 'Checks the repo(s) for uncommitted changes and asks Claude, in the chat, for a clean commit message per repo. Claude will not commit; it notes that you committed everything so far.',
  cost: 'What this session has cost so far, and what the last lap added.',
  safety: 'Safety car: when Claude Code is about to auto-compact, pitwall saves a Handoff first, so nothing is lost.',
}

const FLAG: Record<Level, { glyph: string; text: string }> = {
  ok: { glyph: '🟢', text: 'GREEN FLAG' },
  warn: { glyph: '🟡', text: 'YELLOW FLAG' },
  hot: { glyph: '🔴', text: 'RED FLAG' },
}

const HANDOFF_PROMPT = `[pitwall handoff request — reply with the handoff document only, in markdown, no preamble]

Write a detailed handoff so a fresh Claude session with none of this conversation can pick up the work exactly where we are. Start with a single line "# Handoff: <short title of the work>". Then these sections:

## Goal — what the user is ultimately trying to achieve, and why.
## Current state — what works now, what is half-done, what is broken. Be concrete.
## Decisions made — each decision and the reason behind it, including options rejected.
## Key files & locations — paths, functions, configs, commands that matter, with a line on each.
## Dead ends — approaches tried that failed, and why, so they are not retried.
## Open questions — unresolved issues, things awaiting the user.
## Next steps — an ordered, actionable checklist for the next session.
## Gotchas — environment quirks, credentials needed (never the values), conventions to respect.
## Suggested skills — which skills the next agent should call the Skill tool for (exact names from your skill list), and when.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs, files in the repo): reference them by path or URL instead.
Never include secrets, tokens, passwords, account numbers or customer personal data; describe them generically instead.`

const handoffPrompt = (focus: string) =>
  focus === ''
    ? HANDOFF_PROMPT
    : `${HANDOFF_PROMPT}\n\nThe next session will focus on: ${focus}\nTailor the document to that: lead with what matters for it, and trim what does not.`

const ELI5_PROMPTS = {
  last:
    "[pitwall ELI5 request — reply in markdown only, no preamble]\n\nThe user is tired. Explain your most recent reply as if to a smart 5-year-old: short sentences, no jargon (explain any word you must use), one everyday analogy, and one or two tiny concrete examples. End with a line '**In one line:** …'. Under 200 words.",
  session:
    "[pitwall ELI5 request — reply in markdown only, no preamble]\n\nThe user is tired. Explain this whole session so far as if to a smart 5-year-old: what we are building and why, what is done, what is left, and what happens next. Short sentences, no jargon, one everyday analogy, one concrete example. End with a line '**In one line:** …'. Under 250 words.",
} as const

const AWTY_PROMPT = `[pitwall "Are we there yet?" check — reply with ONE JSON object only: no prose, no code fence]

Look back over this whole session and report where we stand, as:
{"goal": "one line: what the user is ultimately trying to get done",
 "progress": <integer 0-100: honest estimate of how close the goal is>,
 "status": "one line: what is happening right now / what was just done",
 "radio": "the same status as a short F1 race-engineer team-radio call to the driver (under 90 characters, e.g. 'Good pace, tests are green. Box for docs next lap.')",
 "journey": ["3-6 short bullets: the path so far"],
 "blockers": ["open issues or risks; empty if none"],
 "questions": ["exactly 3 next questions the user could ask to move forward, in the user's voice, each under 90 characters"]}`

const clamp = (n: number) => Math.max(0, Math.min(1, n))

const cacheLevel = (frac: number): Level => (frac > 0.5 ? 'ok' : frac > 0.15 ? 'warn' : 'hot')
const contextLevel = (percent: number): Level => (percent < 50 ? 'ok' : percent < 75 ? 'warn' : 'hot')
const bump = (level: Level): Level => (level === 'ok' ? 'warn' : 'hot')
const worst = (...levels: Level[]): Level => (levels.includes('hot') ? 'hot' : levels.includes('warn') ? 'warn' : 'ok')

const clockText = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
// Lap times the way the timing screens show them: 1:23.456, or 42.318 under a minute.
const lapText = (ms: number) => {
  const m = Math.floor(ms / MIN)
  const s = ((ms % MIN) / 1000).toFixed(3).padStart(6, '0')
  return m > 0 ? `${m}:${s}` : String(Number(s).toFixed(3))
}
const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const stamp = (ms: number) => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}
const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session'

const hitRate = (u: ModelUsage) => {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total === 0 ? null : u.cache_read_input_tokens / total
}

const textBar = (frac: number, width: number) => {
  const cells = clamp(frac) * width
  const full = Math.floor(cells)
  const half = cells - full >= 0.5 ? 1 : 0
  return { on: '━'.repeat(full) + (half ? '╸' : ''), off: '━'.repeat(Math.max(0, width - full - half)) }
}

// A gauge. `kerb` stripes the danger zone, a [from, to] range of the track in
// fractions; `marks` are thin ticks at fractions of the track.
const svgBar = (frac: number, color: string, width: number, height: number, kerb: [number, number], marks: number[] = []) => {
  const r = Math.min(height / 2, 4)
  const fill = clamp(frac) * width
  const shown = fill > 0 ? Math.max(fill, height) : 0
  const kerbX = Math.round(width * clamp(kerb[0]))
  const kerbW = Math.round(width * clamp(kerb[1])) - kerbX
  const ticks = marks
    .map(m => `<rect x="${(clamp(m) * width - 1).toFixed(1)}" width="2" height="${height}" fill="#fff" fill-opacity="0.75"/>`)
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.55"/>` +
    `<stop offset="1" stop-color="${color}"/></linearGradient>` +
    `<pattern id="k" width="8" height="${height}" patternUnits="userSpaceOnUse">` +
    `<rect width="4" height="${height}" fill="${RED}"/><rect x="4" width="4" height="${height}" fill="#fff"/></pattern>` +
    `<clipPath id="c"><rect width="${width}" height="${height}" rx="${r}"/></clipPath></defs>` +
    `<g clip-path="url(#c)"><rect width="${width}" height="${height}" fill="#888" fill-opacity="0.22"/>` +
    (kerbW > 0 ? `<rect x="${kerbX}" width="${kerbW}" height="${height}" fill="url(#k)" fill-opacity="0.35"/>` : '') +
    (shown > 0 ? `<rect width="${shown.toFixed(1)}" height="${height}" rx="${r}" fill="url(#g)"/>` : '') +
    ticks +
    `</g></svg>`
  )
}

// The race to the goal: a track, a car at the progress mark, a chequered flag at the end.
const svgRace = (frac: number, width: number, primary: string, accent: string) => {
  const h = 14
  const flagW = 12
  const track = width - flagW - 2
  const x = clamp(frac) * (track - 14)
  const squares: string[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if ((row + col) % 2 === 0) squares.push(`<rect x="${track + 2 + col * 4}" y="${1 + row * 4}" width="4" height="4" fill="currentColor"/>`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" preserveAspectRatio="none" color="#888">` +
    `<rect y="6" width="${track}" height="2" rx="1" fill="#888" fill-opacity="0.35"/>` +
    `<rect y="6" width="${(x + 7).toFixed(1)}" height="2" rx="1" fill="${primary}"/>` +
    `<rect x="${track + 2}" y="1" width="12" height="12" fill="#fff" stroke="#888" stroke-width="0.5"/>` +
    squares.join('') +
    // A tiny side-on car: body, cockpit, wings and two wheels.
    `<g transform="translate(${x.toFixed(1)},2)">` +
    `<path d="M0 6 L3 4 L8 4 L10 2 L12 4 L14 5 L14 7 L0 7 Z" fill="${primary}"/>` +
    `<rect x="4" y="5" width="7" height="1" fill="${accent}"/>` +
    `<rect x="0" y="2" width="1.5" height="4" fill="${primary}"/>` +
    `<circle cx="3" cy="8" r="2" fill="#222"/><circle cx="11.5" cy="8" r="2" fill="#222"/></g>` +
    `</svg>`
  )
}

const textRace = (frac: number, width: number) => {
  const at = Math.round(clamp(frac) * (width - 1))
  return { done: '━'.repeat(at), todo: '┄'.repeat(Math.max(0, width - 1 - at)) }
}

const parseTrip = (text: string): Trip | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const status = String(raw.status ?? '')
    return {
      goal: String(raw.goal ?? ''),
      progress: Math.round(Math.max(0, Math.min(100, Number(raw.progress) || 0))),
      status,
      radio: String(raw.radio ?? status),
      questions: list(raw.questions).slice(0, 3),
      journey: list(raw.journey),
      blockers: list(raw.blockers),
    }
  } catch {
    return null
  }
}

// Module variables: fine to lose on a reload, the next turn sets them again.
let isRunning = false
let turnStartedAt = 0
let nudgedFor: number | null = null
let warnedHot = false

// Sounds are queued here and played by a timer started at session.start, so a
// clip never holds up (or dies with) the hook that asked for it.
type Cue = 'radio' | 'flyby' | 'pitstop'
const SOUNDS: { cue: Cue; label: string; when: string }[] = [
  { cue: 'radio', label: 'Team radio', when: 'Radio check, handoff saved, cache and context warnings' },
  { cue: 'flyby', label: 'Fly-by', when: 'a turn of 45 s or more finishes' },
  { cue: 'pitstop', label: 'Pit stop', when: 'Compact finishes' },
]
const cues: Cue[] = []
let player: string | null = null
let isPlaying = false

function cue(name: Cue) {
  if (cues.length < 4) cues.push(name)
}

async function pickPlayer($: Engine) {
  // $.audio.play only has a player on macOS; Linux desktops have PulseAudio or PipeWire.
  for (const bin of ['paplay', 'pw-play', 'aplay']) {
    const ok = await $.process
      .run([bin, '--version'], { timeoutMs: 2000 })
      .then(
        r => r.exitCode === 0,
        err => logLine($, `probe ${bin}: ${String(err).slice(0, 200)}`).then(() => false),
      )
    if (ok) return bin
  }
  return 'engine'
}

// What pitwall did and why, for when something looks like it did nothing.
const LOG = '/tmp/pitwall.log'
// Clips sound 30% as loud as the system's current volume. Loudness halves every
// 10 dB, so 30% is a -17.4 dB gain: 0.135 in amplitude, and 51% on PulseAudio's
// cubic volume scale.
const LOUDNESS = 0.3
const GAIN = 10 ** ((10 * Math.log2(LOUDNESS)) / 20)
const PULSE_VOLUME = Math.round(65536 * Math.cbrt(GAIN))

async function logLine($: Engine, line: string) {
  const at = new Date(await $.clock.now()).toISOString()
  const before = (await $.fs.exists(LOG)) ? String(await $.fs.read(LOG)) : ''
  await $.fs.write(LOG, `${before}${at} ${line}\n`.slice(-20_000))
}

// Plays one clip now; says what happened, so a silent failure is never silent.
async function play($: Engine, name: Cue): Promise<string> {
  try {
    if (player === null) player = await pickPlayer($)
    const file = `sounds/${name}.wav`
    if (player === 'engine') {
      await $.audio.play({ asset: file }, { gain: GAIN })
      await logLine($, `${name}: $.audio.play resolved`)
      return 'ok'
    }
    const path = `${$.plugin.root}/${file}`
    // paplay counts 65536 as 100% of the stream, which plays relative to the system volume.
    const argv =
      player === 'paplay'
        ? [player, `--volume=${PULSE_VOLUME}`, path]
        : player === 'pw-play'
          ? [player, `--volume=${Math.cbrt(GAIN).toFixed(3)}`, path]
          : [player, path]
    const r = await $.process.run(argv, { timeoutMs: 15_000 })
    const said = `${name}: ${player} exit ${r.exitCode}${r.stderr ? ` stderr: ${r.stderr.trim().slice(0, 300)}` : ''}`
    await logLine($, said)
    return r.exitCode === 0 ? 'ok' : said
  } catch (err) {
    const said = `${name}: ${player ?? 'no player'} failed: ${String(err).slice(0, 300)}`
    await logLine($, said).catch(() => undefined)
    return said
  }
}

async function testSound($: Engine, name: Cue) {
  const result = await play($, name)
  if (result !== 'ok') $.ui.toast(`🔇 pitwall sound failed: ${result}`, { timeoutMs: 15_000 })
}

async function drain($: Engine) {
  if (isPlaying || cues.length === 0) return
  const next = cues.shift()
  if (next === undefined) return
  isPlaying = true
  try {
    if (await read($, isSoundOn)) await play($, next)
  } finally {
    isPlaying = false
  }
}

// Context is measured against where auto-compaction runs, not the raw window: that is
// when the conversation actually gets cut. `summary` estimates locally, no request.
async function refreshContext($: Engine) {
  const { context: c, cost: spent } = await $.session.usage({ breakdown: 'summary' })
  if (spent !== undefined) await update($, cost, (was): Cost | null => ({ usd: spent.usd, lastLapUsd: was?.lastLapUsd ?? null }))
  if (c.tokens === undefined) {
    await update($, context, (): Context | null => null)
    return
  }
  const tokens = c.tokens
  const limit = c.breakdown?.autoCompactThreshold ?? c.window
  const next: Context = { percent: Math.min(100, Math.round((100 * tokens) / limit)), tokens, window: c.window, limit }
  await update($, context, (): Context | null => next)
}

// Any request that read the main thread's cache refreshed its TTL.
async function markFresh($: Engine, usage: ModelUsage) {
  if (usage.cache_read_input_tokens > 0) {
    const at = await $.clock.now()
    await update($, lastAt, () => at)
  }
}

async function newestHandoff($: Engine) {
  const root = await $.session.root()
  const dir = `${root}/.handoff`
  if (!(await $.fs.exists(dir))) return null
  const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md'))
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files[0]?.name ?? null
}

async function ensureIgnored($: Engine, root: string) {
  const path = `${root}/.gitignore`
  const text = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  if (/^\/?\.handoff\/?\s*$/m.test(text)) return false
  const lead = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  await $.fs.write(path, `${text}${lead}# Session handoffs (pitwall)\n.handoff/\n`)
  return true
}

// The prompt that starts the next session from a handoff file.
const resumePrompt = (name: string) =>
  `Pick up where the last session left off. Read @.handoff/${name} first, confirm the current state, then continue with the next steps.`

async function doHandoff($: Engine, focus = ''): Promise<string> {
  if ((await read($, busy)) !== null) return 'pitwall is already busy.'
  await update($, busy, (): Busy => 'handoff')
  try {
    const r = await $.model.fork({ prompt: handoffPrompt(focus.trim()) })
    if (!r.isAnswered) {
      const why = `Handoff failed: ${r.reason}.`
      $.ui.toast(`pitwall: ${why}`)
      return why
    }
    await markFresh($, r.usage)
    const root = await $.session.root()
    const at = await $.clock.now()
    const title = r.text.match(/^#\s*(?:Handoff:\s*)?(.+)$/m)?.[1]?.trim() ?? 'session'
    const name = `${stamp(at)}-${slug(title)}.md`
    const files = await read($, touched)
    const body = [
      r.text.trim(),
      ...(focus.trim() === '' ? [] : ['', `> **Next session focus:** ${focus.trim()}`]),
      '',
      '---',
      '',
      '## Files touched this session (tracked by pitwall)',
      files.length > 0 ? files.map(f => `- \`${f}\``).join('\n') : '_None recorded._',
      '',
      '## How to resume',
      'Start a new session in this project and run `/resume-handoff`, or paste:',
      '',
      '```',
      resumePrompt(name),
      '```',
      '',
    ].join('\n')
    await $.fs.write(`${root}/.handoff/${name}`, body)
    const isNewIgnore = await ensureIgnored($, root)
    const ignoreNote = isNewIgnore ? ' (added .handoff/ to .gitignore)' : ''
    const said = `Handoff saved to .handoff/${name}${ignoreNote}.`
    const note: ResumeNote = { name, text: resumePrompt(name) }
    await update($, resumeNote, (): ResumeNote | null => note)
    await notify($, '📋 Handoff saved', `.handoff/${name}. The resume prompt is on the pitwall, ready to copy.`)
    cue('radio')
    $.ui.toast(`📋 Handoff saved: .handoff/${name}${ignoreNote}. Ready for the next stint.`, { timeoutMs: 8000 })
    return said
  } finally {
    await update($, busy, (): Busy => null)
  }
}

// Grill me: runs mattpocock's grilling skill in the chat on a topic, or on the current plan.
async function doGrill($: Engine, topic: string): Promise<string> {
  const args = topic.trim() === '' ? 'Grill me on the plan we have so far in this conversation.' : topic.trim()
  try {
    await $.command.run({ command: 'mattpocock-skills:grilling', args })
    return 'Grilling started in the chat.'
  } catch {
    // Not runnable from here (skill missing or refused): leave it in the prompt box to send.
    await $.prompt.fill({ text: `/mattpocock-skills:grilling ${args}` })
    return 'Put /mattpocock-skills:grilling in the prompt box: press Enter to start.'
  }
}

// ELI5: a side question to a copy of the conversation; the answer shows in a card.
async function doEli5($: Engine, mode: keyof typeof ELI5_PROMPTS): Promise<string> {
  if ((await read($, busy)) !== null) return 'pitwall is already busy.'
  await update($, busy, (): Busy => 'eli5')
  try {
    const r = await $.model.fork({ prompt: ELI5_PROMPTS[mode] })
    if (!r.isAnswered) {
      const why = r.reason === 'nothing-to-fork' ? 'Nothing to explain yet: send a first prompt.' : `ELI5 failed: ${r.reason}.`
      $.ui.toast(`pitwall: ${why}`)
      return why
    }
    await markFresh($, r.usage)
    const shown: Explained = { title: mode === 'last' ? 'The last answer, simply' : 'Where we are, simply', text: r.text.trim() }
    await update($, explained, (): Explained | null => shown)
    return shown.text
  } finally {
    await update($, busy, (): Busy => null)
  }
}

// What each busy state is called in the "hang on" notice.
const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  handoff: 'Writing the handoff',
  awty: 'Running the radio check',
  compact: 'Compacting',
  commit: 'Checking repos',
  eli5: 'Writing the ELI5',
}

async function openForm($: Engine, which: Form) {
  // Nothing opens while the conversation is in the pits.
  if (which !== null && ((await read($, isCompacting)) || (await read($, busy)) === 'compact')) {
    $.ui.toast("🔧 Compacting… the pitwall's back once it's done.")
    return
  }
  // pitwall runs one job at a time; Grill me runs in the chat, so it never waits.
  const doing = await read($, busy)
  if (doing !== null && which !== null && which !== 'grill') {
    $.ui.toast(`⏳ ${BUSY_TEXT[doing]}… hang on, it'll be free in a moment.`)
    return
  }
  await update($, form, (open): Form => (open === which ? null : which))
}

// A confirm card's go button: closes the card, then runs the action.
async function runForm($: Engine, action: () => Promise<unknown>) {
  await update($, form, (): Form => null)
  await action()
}

// Text goes in the real prompt box: the command is typed there, the person adds
// the focus or topic and presses Enter. Full width, and nothing to rebuild.
async function typeInPrompt($: Engine, command: string) {
  await update($, form, (): Form => null)
  await $.prompt.fill({ text: `${command} ` })
}

async function doAwty($: Engine): Promise<string> {
  if ((await read($, busy)) !== null) return 'pitwall is already busy.'
  await update($, busy, (): Busy => 'awty')
  try {
    const r = await $.model.fork({ prompt: AWTY_PROMPT })
    if (!r.isAnswered) {
      const why =
        r.reason === 'nothing-to-fork' ? 'Nothing to check yet: send a first prompt.' : `Check failed: ${r.reason}.`
      $.ui.toast(`pitwall: ${why}`)
      return why
    }
    await markFresh($, r.usage)
    const next = parseTrip(r.text)
    if (next === null) {
      $.ui.toast('pitwall: could not read the status reply; try again.')
      return 'Could not read the status reply.'
    }
    await update($, trip, (): Trip | null => next)
    $.ui.toast(`📻 "${next.radio}"`, { timeoutMs: 8000 })
    cue('radio')
    const lines = [
      `📻 Radio check: ${next.progress}% race distance`,
      `"${next.radio}"`,
      `Goal: ${next.goal}`,
      `Now: ${next.status}`,
      ...(next.journey.length > 0 ? ['So far:', ...next.journey.map(j => `  • ${j}`)] : []),
      ...(next.blockers.length > 0 ? ['Open:', ...next.blockers.map(b => `  • ${b}`)] : []),
      ...(next.questions.length > 0 ? ['Ask next:', ...next.questions.map(q => `  → ${q}`)] : []),
    ]
    return lines.join('\n')
  } finally {
    await update($, busy, (): Busy => null)
  }
}

// The reason an engine call gave, without the "pitwall: " the engine puts in front.
const reason = (err: unknown) =>
  String(err instanceof Error ? err.message : err)
    .replace(/^(pitwall: )+/, '')
    .slice(0, 200)

// Compact asks the engine directly (a terminal session), else runs Claude Code's own
// /compact (the desktop app and SDK, where compaction runs inside a turn), else leaves
// /compact in the prompt box. The session.compact hook reports the result either way.
async function doCompact($: Engine) {
  if (isRunning) {
    $.ui.toast('📻 Stay out, stay out. Box after this lap finishes.')
    return
  }
  if ((await read($, busy)) !== null) return
  await update($, busy, (): Busy => 'compact')
  try {
    try {
      const r = await $.session.compact()
      if (r.skip !== undefined) {
        await logLine($, `compact: skipped: ${r.skip}`).catch(() => undefined)
        $.ui.toast(`pitwall: compaction skipped: ${r.skip}`)
      }
      return
    } catch (err) {
      await logLine($, `compact: direct call refused: ${reason(err)}`).catch(() => undefined)
    }
    try {
      await $.command.run({ command: 'compact' })
      await logLine($, 'compact: ran /compact').catch(() => undefined)
      return
    } catch (err) {
      await logLine($, `compact: /compact refused: ${reason(err)}`).catch(() => undefined)
    }
    await $.prompt.fill({ text: '/compact' }).catch(() => undefined)
    $.ui.toast("🔧 Couldn't start the compaction from the pitwall: /compact is in the prompt box, press Enter.", {
      timeoutMs: 12_000,
    })
  } finally {
    await update($, busy, (): Busy => null)
  }
}

async function doResume($: Engine): Promise<string> {
  const name = await newestHandoff($)
  if (name === null) return 'No handoff found in .handoff/.'
  await $.prompt.fill({ text: resumePrompt(name) })
  await update($, resumable, () => null)
  return `Loaded .handoff/${name} into the prompt. Press Enter to continue.`
}

// A desktop notification. Claude Code's own channel does not reach the desktop app,
// so it falls back to notify-send on Linux and osascript on macOS.
async function notify($: Engine, title: string, body: string) {
  if (!(await read($, isNotifyOn))) return
  // Claude Code's own channel first; where it is missing or refuses, the OS notifier.
  try {
    const sent = await $.ui.notify(body, { title })
    if (sent.isSent) return
  } catch {
    // fall through to the OS notifier
  }
  const isLinuxSent = await $.process
    .run(['notify-send', '--app-name=Claude Code', '--icon=dialog-information', title, body], { timeoutMs: 5000 })
    .then(r => r.exitCode === 0, () => false)
  if (isLinuxSent) return
  // macOS: AppleScript's notification, the text passed as arguments rather than spliced into the script.
  await $.process
    .run(
      ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
      { timeoutMs: 5000 },
    )
    .catch(() => undefined)
}

// Copies to the clipboard: Claude Code's own copy first, then the OS tool
// (wl-copy on Wayland, xclip on X11, pbcopy on macOS).
async function copyText($: Engine, text: string, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  try {
    const r = await $.ui.copy({ text, surface })
    if (r.isCopied) return true
  } catch {
    // fall through to the OS tools
  }
  for (const argv of [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['pbcopy']]) {
    const ok = await $.process
      .run(argv, { stdin: text, timeoutMs: 5000 })
      .then(r => r.exitCode === 0, () => false)
    if (ok) return true
  }
  return false
}

async function copyResume($: Engine, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  const note = await read($, resumeNote)
  if (note === null) return
  const isCopied = await copyText($, note.text, surface)
  $.ui.toast(
    isCopied ? '📋 Copied. Paste it into a new chat in this project.' : "pitwall: couldn't copy here. Select the text in the card instead.",
    { timeoutMs: 6000 },
  )
}

async function toggleNotify($: Engine): Promise<string> {
  const on = !(await read($, isNotifyOn))
  await update($, isNotifyOn, () => on)
  await $.store.set('notify', on)
  if (on) await notify($, '🏎️ Pitwall', 'Desktop notifications on.')
  return on ? '🔔 Desktop notifications on.' : '🔕 Desktop notifications off.'
}

// The repos to check: the session's own, plus any repo one folder down from the project root.
async function findRepos($: Engine): Promise<string[]> {
  const root = await $.session.root()
  const found: string[] = []
  const own = await $.session.repo().catch(() => null)
  if (own !== null) found.push(own.root)
  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const dir = `${root}/${entry.name}`
    if (!found.includes(dir) && (await $.fs.exists(`${dir}/.git`))) found.push(dir)
  }
  return found
}

async function git($: Engine, repo: string, args: string[]) {
  const r = await $.process.run(['git', '-C', repo, ...args], { timeoutMs: 10_000 }).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 ? r.stdout.trim() : ''
}

// Self commit: gather what is uncommitted, then ask Claude in the chat for a commit
// message per repo. The ask itself tells Claude the person commits this work.
async function doSelfCommit($: Engine): Promise<string> {
  if ((await read($, busy)) !== null) return 'pitwall is already busy.'
  await update($, busy, (): Busy => 'commit')
  try {
    const repos = await findRepos($)
    if (repos.length === 0) {
      $.ui.toast('pitwall: no git repo found in this project.')
      return 'No git repo found.'
    }
    const root = await $.session.root()
    const sections: string[] = []
    for (const repo of repos) {
      const status = (await git($, repo, ['status', '--porcelain=v1', '--branch'])).split('\n').filter(Boolean)
      const changes = status.slice(1)
      if (changes.length === 0) continue
      const branch = status[0]?.replace(/^## /, '') ?? 'unknown'
      const stat = await git($, repo, ['diff', 'HEAD', '--stat', '--no-color'])
      const name = repo === root ? '.' : repo.startsWith(`${root}/`) ? repo.slice(root.length + 1) : repo
      sections.push(
        [
          `Repo: ${name} (branch ${branch})`,
          'Changes:',
          ...changes.slice(0, 60),
          ...(changes.length > 60 ? [`… and ${changes.length - 60} more`] : []),
          ...(stat ? ['Diff summary:', ...stat.split('\n').slice(-40)] : []),
        ].join('\n'),
      )
    }
    if (sections.length === 0) {
      $.ui.toast('✅ Nothing to commit: every repo is clean.')
      return 'Nothing to commit.'
    }
    const text = [
      "[Self commit] I'm committing the work so far myself. Don't run git add, commit or push.",
      'Write one clean commit message per repo below: a conventional-commit subject line (72 characters max), ' +
        "a blank line, then a short body saying what changed and why, drawn from this session's work. " +
        'Put each message in its own code block so I can copy it.',
      'From here on, treat everything listed below as committed by me.',
      '',
      sections.join('\n\n'),
    ].join('\n')
    await $.prompt.submit({ text, asUser: true })
    return `Asked for commit messages for ${sections.length} repo${sections.length > 1 ? 's' : ''}.`
  } finally {
    await update($, busy, (): Busy => null)
  }
}

async function toggleSound($: Engine): Promise<string> {
  const on = !(await read($, isSoundOn))
  await update($, isSoundOn, () => on)
  await $.store.set('sound', on)
  if (on) cue('radio')
  return on ? '🔊 Sounds on.' : '🔇 Sounds off.'
}

async function tick($: Engine) {
  const t = await $.clock.now()
  await update($, now, () => t)
  const at = await read($, lastAt)
  const c = await read($, context)
  if (at === null || c === null || isRunning || c.percent < 70 || nudgedFor === at) return
  const left = at + (await read($, ttl)).ms - t
  if (left > 0 && left <= FIVE_MIN) {
    nudgedFor = at
    cue('radio')
    const said = `Cache expires in ${clockText(left)} with context ${c.percent}% full. Handoff or Compact now.`
    $.ui.toast(`📻 Box, box! ${said}`, { timeoutMs: 10_000 })
    await notify($, '📻 Box, box!', said)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Write a detailed handoff to .handoff/ for the next session',
      argumentHint: '[what the next session will focus on]',
    })
    await $.command.register({
      name: 'eli5',
      description: "Explain the last answer (or 'session': the whole session) like I'm 5",
      argumentHint: '[session]',
    })
    await $.command.register({ name: 'are-we-there-yet', description: 'Summarize the session, its progress, and 3 questions to ask next' })
    await $.command.register({ name: 'resume-handoff', description: 'Load the newest .handoff/ file into the prompt' })
    await $.command.register({ name: 'pitwall-sound', description: 'Turn pitwall sounds on or off' })
    await $.command.register({ name: 'pitwall-notify', description: 'Turn pitwall desktop notifications on or off' })
    await $.command.register({ name: 'self-commit', description: 'Ask Claude for commit messages for your uncommitted changes' })
    const savedNotify = await $.store.get('notify')
    if (typeof savedNotify === 'boolean') await update($, isNotifyOn, () => savedNotify)
    // Clear what the multi-livery version saved.
    if ((await $.store.get('theme')) !== undefined) await $.store.delete('theme')
    const savedSound = await $.store.get('sound')
    if (typeof savedSound === 'boolean') await update($, isSoundOn, () => savedSound)
    $.clock.every(1000, () => void tick($))
    $.clock.every(150, () => void drain($))
    await refreshContext($)
    if ((await $.session.turns()) === 0) {
      const name = await newestHandoff($)
      await update($, resumable, () => name)
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => ({ text: await doHandoff($, e.args) }))
  on('command.run', { command: 'eli5' }, async ($, e) => ({
    text: await doEli5($, e.args.trim().toLowerCase().startsWith('s') ? 'session' : 'last'),
  }))
  on('command.run', { command: 'are-we-there-yet' }, async $ => ({ text: await doAwty($) }))
  on('command.run', { command: 'resume-handoff' }, async $ => ({ text: await doResume($) }))
  on('command.run', { command: 'pitwall-sound' }, async $ => ({ text: await toggleSound($) }))
  on('command.run', { command: 'pitwall-notify' }, async $ => ({ text: await toggleNotify($) }))
  on('command.run', { command: 'self-commit' }, async $ => ({ text: await doSelfCommit($) }))

  // Every compaction of the main conversation, however it started (Compact, a typed
  // /compact, auto-compact): a Safety car handoff before an auto one, then the result.
  // Compaction always goes on, whatever happens here.
  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    if (e.trigger === 'auto' && isMain) {
      $.ui.toast('🚗 Safety car: auto-compact coming. Saving a Handoff first.', { timeoutMs: 8000 })
      const said = await doHandoff($).catch(err => `Handoff failed: ${reason(err)}`)
      await notify($, '🚗 Safety car', `Auto-compact: ${said}`)
    }
    const before = (await read($, context))?.percent
    const started = await $.clock.now()
    if (isMain) {
      await update($, isCompacting, () => true)
      await update($, form, (): Form => null)
    }
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      if (isMain) await update($, isCompacting, () => false)
    }
    if (!isMain || r.skip !== undefined) return r

    const at = await $.clock.now()
    await logLine($, `compact (${e.trigger}): ${r.tokensBefore ?? '?'} -> ${r.tokensAfter ?? '?'} tokens`).catch(() => undefined)
    await update($, lastAt, () => at)
    warnedHot = false
    // The context reading only moves with the next reply; the compaction's own count is current now.
    const tokensAfter = r.tokensAfter
    if (tokensAfter !== undefined) {
      await update($, context, (c): Context | null =>
        c === null ? null : { ...c, tokens: tokensAfter, percent: Math.min(100, Math.round((100 * tokensAfter) / c.limit)) },
      )
    }
    const after = (await read($, context))?.percent
    cue('pitstop')
    const fill = before !== undefined && after !== undefined ? ` Context ${before}% → ${after}% used.` : ''
    $.ui.toast(`🔧 Pit stop complete: stationary ${((at - started) / 1000).toFixed(1)}s.${fill}`, { timeoutMs: 8000 })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isRunning = true
    turnStartedAt = await $.clock.now()
    await update($, resumable, () => null)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    isRunning = false
    const at = await $.clock.now()
    const before = await read($, context)
    const prevAt = await read($, lastAt)
    const usage = e.usage

    // Every answered turn is a lap.
    if (!e.isAborted) {
      const lap = e.durationMs
      await update($, laps, (l): Laps => ({
        count: l.count + 1,
        lastMs: lap,
        bestMs: l.bestMs === null ? lap : Math.min(l.bestMs, lap),
      }))
      if (lap >= 45_000) {
        cue('flyby')
        void notify($, `🏁 Lap ${(await read($, laps)).count} done`, `That turn took ${lapText(lap)}.`)
      }
    }

    if (usage !== undefined) {
      const rate = hitRate(usage)
      await update($, hit, () => rate)

      // Learn the TTL: after a 5–60 min gap, did the turn re-write the whole prefix?
      const gap = turnStartedAt - (prevAt ?? turnStartedAt)
      if (prevAt !== null && before !== null && before.tokens > 0 && gap > FIVE_MIN + 30_000 && gap < HOUR) {
        const isMiss = usage.cache_creation_input_tokens >= 0.6 * before.tokens
        await update($, ttl, (): Ttl => ({ ms: isMiss ? FIVE_MIN : HOUR, isConfirmed: true }))
      }
      await update($, lastAt, () => at)
    }

    const costBefore = (await read($, cost))?.usd
    await refreshContext($)
    const costAfter = await read($, cost)
    if (costBefore !== undefined && costAfter !== null && costAfter.usd >= costBefore) {
      const lapUsd = costAfter.usd - costBefore
      await update($, cost, (): Cost | null => ({ usd: costAfter.usd, lastLapUsd: lapUsd }))
    }
    const c = await read($, context)
    // A turn that grew the context counts toward the per-lap rate; a drop is a compaction.
    if (before !== null && c !== null && c.tokens > before.tokens) {
      const used = c.tokens - before.tokens
      await update($, burn, list => [...list, used].slice(-6))
    }
    if (c !== null && c.percent >= 85 && !warnedHot) {
      warnedHot = true
      cue('radio')
      $.ui.toast(`📻 Context ${c.percent}% full. Box, box: Handoff or Compact now.`, { timeoutMs: 10_000 })
      await notify($, '📻 Context critical', `Context ${c.percent}% full. Handoff or Compact now.`)
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const args = e as unknown as { tool: string; file_path?: unknown; notebook_path?: unknown }
    const path =
      args.tool === 'Edit' || args.tool === 'Write'
        ? args.file_path
        : args.tool === 'NotebookEdit'
          ? args.notebook_path
          : undefined
    if (typeof path === 'string' && ran.deny === undefined && ran.isError !== true) {
      const root = await $.session.root()
      const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
      await update($, touched, list => (list.includes(rel) ? list : [...list, rel].slice(-300)))
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined

    const t = (await read($, now)) || (await $.clock.now())
    const at = await read($, lastAt)
    const rate = await read($, hit)
    const life = await read($, ttl)
    const c = await read($, context)
    const doing = await read($, busy)
    const where = await read($, trip)
    const resume = await read($, resumable)
    const isOpen = await read($, isTripOpen)
    const isSound = await read($, isSoundOn)
    const isLegend = await read($, isLegendOpen)
    const lap = await read($, laps)
    const burned = await read($, burn)
    const spent = await read($, cost)
    const isNotify = await read($, isNotifyOn)
    const openForm_ = await read($, form)
    const shown = await read($, explained)
    const note = await read($, resumeNote)
    const compacting = await read($, isCompacting)
    const Markdown = els.Markdown
    const isWorking = e.props.isWorking


    // Gauge grid: label column, bar column taking every cell left, info column.
    const cols = e.props.bodyColumns
    const LABEL = 7
    const GAP = 2

    const cell = (child: JSX.Element | string) => (
      <Box height={1} flexDirection="row" alignItems="center">
        {child}
      </Box>
    )
    const bar = (frac: number, level: Level, alt: string, isDim: boolean, kerb: [number, number], marks: number[] = []) => (
      <Box height={1} flexDirection="row" alignItems="center">
        {Svg !== undefined ? (
          <Svg source={svgBar(frac, isDim ? '#888888' : HEX[level], px, 10, kerb, marks)} alt={alt} height={10} />
        ) : (
          <Text>
            <Text color={THEME[level]} dimColor={isDim}>{textBar(frac, cells).on}</Text>
            <Text dimColor>{textBar(frac, cells).off}</Text>
          </Text>
        )}
      </Box>
    )

    // A hover card: hidden until the pointer is over its keyed Box, drawn over
    // what is beside it without moving anything.
    const tip = (key: string, text: string, child: JSX.Element, place: { top?: number; left?: number } = {}) => (
      <Box key={key} flexDirection="row">
        {child}
        <Box
          position="absolute"
          top={place.top ?? 0}
          left={place.left ?? LABEL + GAP}
          display="none"
          hover={{ display: 'flex' }}
          backgroundColor={RED}
          paddingX={1}
        >
          <Text color="#ffffff">{text}</Text>
        </Box>
      </Box>
    )

    // Cache: time left before the prompt cache expires.
    const ttlLabel = `TTL ${life.ms === HOUR ? '1h' : '5m'}${life.isConfirmed ? '' : '?'}`
    const left = at === null ? 0 : at + life.ms - t
    const cacheFrac = isWorking ? 1 : clamp(left / life.ms)
    const cLevel: Level = isWorking ? 'ok' : cacheLevel(cacheFrac)
    const hitText = rate === null ? '' : ` · ${Math.round(rate * 100)}% hit`
    const cacheText =
      at === null
        ? 'in the garage: waiting for the first lap'
        : isWorking
          ? `live, refreshing${hitText}`
          : left > 0
            ? `${ttlLabel} · ${clockText(left)} left${hitText}`
            : 'expired: next prompt re-reads everything'

    // Context: how full it is, measured to the auto-compact point.
    const pct = c?.percent ?? 0
    const xLevel = contextLevel(pct)
    const perLap = burned.length === 0 ? null : burned.reduce((a, b) => a + b, 0) / burned.length
    const lapsLeft = c === null || perLap === null ? null : Math.max(0, Math.floor((c.limit - c.tokens) / perLap))
    const ctxText =
      c === null
        ? 'no reading yet'
        : `${pct}% used${lapsLeft === null ? '' : ` · ~${lapsLeft} laps left`} · ${kTokens(c.tokens)} / ${kTokens(c.limit)}`

    // What hovering a bar tells you: the numbers behind it.
    const cacheDetail =
      at === null
        ? 'No reply yet, so nothing is cached.'
        : `Refreshed ${clockText(t - at)} ago, expires at ${new Date(at + life.ms).toTimeString().slice(0, 5)}.` +
          (c === null ? '' : ` If it expires, the next prompt re-sends ${kTokens(c.tokens)} tokens uncached.`)
    const contextDetail =
      c === null
        ? 'No context reading yet.'
        : `${kTokens(c.tokens)} used of ${kTokens(c.limit)} before auto-compact (window ${kTokens(c.window)}).` +
          (perLap === null ? '' : ` Filling ~${kTokens(perLap)} a lap over the last ${burned.length}.`)

    // The handoff gets more urgent as the cache runs down on a big context.
    const isCacheLow = at !== null && !isWorking && (left <= 0 || cLevel !== 'ok')
    const hLevel: Level = isCacheLow && pct >= 40 ? bump(xLevel) : xLevel
    const isNudge = !isWorking && at !== null && ((pct >= 70 && left > 0 && left <= FIVE_MIN) || pct >= 85)
    const cacheFlag: Level = at === null || isWorking ? 'ok' : left <= 0 ? 'warn' : cLevel
    const flagLevel = worst(cacheFlag, xLevel)
    const flag = FLAG[flagLevel]
    const isFinished = where !== null && where.progress >= 95

    // Why the flag is this color, in a sentence or two, and what to do about it.
    const cacheWhy =
      at === null
        ? 'nothing is cached yet'
        : isWorking
          ? 'the cache is refreshing while the turn runs'
          : left <= 0
            ? `the cache expired, so the next prompt re-reads ${c === null ? 'the whole context' : `all ${kTokens(c.tokens)} tokens`}`
            : `the cache has ${clockText(left)} left`
    const contextWhy =
      c === null ? 'there is no context reading yet' : `context is ${pct}% used${lapsLeft === null ? '' : ` (~${lapsLeft} laps left)`}`
    const causes = [
      { level: cacheFlag, text: cacheWhy },
      { level: xLevel, text: contextWhy },
    ]
    const listed = (texts: string[]) =>
      texts.length <= 1 ? (texts[0] ?? '') : `${texts.slice(0, -1).join(', ')} and ${texts[texts.length - 1]}`
    const why = listed(causes.filter(x => flagLevel === 'ok' || x.level === flagLevel).map(x => x.text))
    const advice =
      flagLevel === 'ok'
        ? 'Nothing to do, keep going.'
        : flagLevel === 'warn'
          ? 'Plan a Handoff or Compact at a good stopping point.'
          : xLevel === 'hot'
            ? 'Compact now, or Handoff and start fresh, before it auto-compacts.'
            : 'Send your next prompt or Handoff before the cache runs out.'
    const flagTip = isFinished
      ? `Chequered flag: your last Radio check puts the goal at ${where.progress}%. Wrap up, then Handoff so the next session starts clean.`
      : `${flag.text.charAt(0)}${flag.text.slice(1).toLowerCase()}: ${why}. ${advice}`

    // Terminal text bars need a cell count: what is left after the label and the longest info text.
    const raceInfo = where === null ? '' : `LAP ${Math.max(1, Math.round(where.progress / 2))}/50 · ${where.progress}%`
    const info = Math.min(44, Math.max(cacheText.length, ctxText.length, raceInfo.length) + 1)
    const cells = Math.max(10, cols - LABEL - info - GAP * 2)
    // Desktop: the SVG asks for more than the bar column can hold (≥10 px a cell); the
    // column caps it, and preserveAspectRatio="none" stretches it to the full width.
    const px = cols * 10

    const label = (text: string) => (
      <Box width={LABEL} flexShrink={0}>
        <Text bold>{text}</Text>
      </Box>
    )
    const isPurple = lap.lastMs !== null && lap.bestMs === lap.lastMs && lap.count > 1

    const handoffLabel =
      doing === 'handoff' ? 'Writing handoff…' : hLevel === 'hot' ? '📋 Handoff now' : '📋 Handoff'
    // In the pits: the compact button started one, or one is running (typed /compact, auto-compact).
    const isPitting = doing === 'compact' || compacting
    const isLocked = doing !== null || compacting
    const compactLabel = isPitting ? 'Compacting…' : xLevel === 'hot' ? '🔧 Compact now' : '🔧 Compact'
    // The confirm card on show: none while in the pits.
    const card = isPitting ? null : openForm_
    const awtyLabel = doing === 'awty' ? 'Calling the pit wall…' : 'Radio check'
    const commitLabel = doing === 'commit' ? 'Checking repos…' : 'Self commit'
    const eli5Label = doing === 'eli5' ? 'Simplifying…' : 'ELI5'

    // A confirm card under the buttons: what is about to happen, the go button(s), Cancel.
    const confirm = (which: Exclude<Form, null>, text: string, actions: JSX.Element[]) => (
      <Box flexDirection="column" rowGap={1} borderStyle="round" borderColor={RED} borderDimColor paddingX={1}>
        <Text>{text}</Text>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap">
          {actions}
          <Button key={`${which}-cancel`} plain dimColor label="Cancel" onPress={() => void openForm($, null)} />
        </Box>
      </Box>
    )

    // One legend row: a fixed name column, the meaning wrapping in the rest.
    const NAME_COL = 17
    const tableRow = (name: JSX.Element, meaning: JSX.Element) => (
      <Box flexDirection="row" columnGap={GAP}>
        <Box width={NAME_COL} flexShrink={0}>
          {name}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {meaning}
        </Box>
      </Box>
    )

    const legend: [string, string][] = [
      ['CACHE', TIPS.cache],
      ['CONTEXT', TIPS.context],
      ['RACE', TIPS.race],
      ['LAP', TIPS.lap],
      ['$ COST', TIPS.cost],
      ['FLAG', TIPS.flag],
      ['📋 Handoff', TIPS.handoff],
      ['🔧 Compact', TIPS.compact],
      ['✅ Self commit', TIPS.commit],
      ['🔥 Grill me', TIPS.grill],
      ['🧒 ELI5', TIPS.eli5],
      ['📻 Radio check', TIPS.radio],
      ['🚗 Safety car', TIPS.safety],
      ['🔔  🔊', 'Desktop notifications and sounds on or off (also /pitwall-notify and /pitwall-sound).'],
    ]

    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        <Box flexDirection="row" gap={GAP} justifyContent="space-between">
          {tip(
            'tip-lap',
            `${TIPS.lap} ${TIPS.cost}`,
            <Text>
              <Text bold color={RED}>🏎️ PITWALL</Text>
              <Text dimColor>{lap.count > 0 ? ` · LAP ${lap.count}` : ' · GRID'}</Text>
              {lap.lastMs !== null && <Text dimColor>{` · last ${lapText(lap.lastMs)}`}</Text>}
              {lap.bestMs !== null && lap.count > 1 && (
                <Text color={isPurple ? PURPLE : undefined} dimColor={!isPurple}>
                  {` · best ${lapText(lap.bestMs)}${isPurple ? ' 🟣' : ''}`}
                </Text>
              )}
              {spent !== null && (
                <Text>
                  <Text bold>{` · $${spent.usd.toFixed(2)}`}</Text>
                  {spent.lastLapUsd !== null && <Text dimColor>{` (+$${spent.lastLapUsd.toFixed(2)})`}</Text>}
                </Text>
              )}
            </Text>,
            { top: 1, left: 0 },
          )}
          <Box flexDirection="row" gap={GAP}>
            {tip(
              'tip-flag',
              flagTip,
              <Text bold color={isFinished ? undefined : THEME[flagLevel]}>
                {isFinished ? '🏁 CHEQUERED FLAG' : `${flag.glyph} ${flag.text}`}
              </Text>,
              { top: 1, left: -40 },
            )}
            <Button
              key="notify"
              label={isNotify ? '🔔' : '🔕'}
              plain
              dimColor
              onPress={() => void toggleNotify($)}
            />
            <Button
              key="sound"
              label={isSound ? '🔊' : '🔇'}
              plain
              dimColor
              onPress={() => void toggleSound($)}
            />
            <Button
              key="legend"
              label={isLegend ? '✕ legend' : '? legend'}
              plain
              dimColor
              onPress={() => void update($, isLegendOpen, open => !open)}
            />
          </Box>
        </Box>
        {isLegend && (
          <Box flexDirection="column" borderStyle="round" borderColor={RED} borderDimColor paddingX={1}>
            {tableRow(<Text bold dimColor>ITEM</Text>, <Text bold dimColor>WHAT IT MEANS</Text>)}
            {legend.map(([name, meaning]) =>
              tableRow(
                <Text bold color={RED}>
                  {name}
                </Text>,
                <Text>{meaning}</Text>,
              ),
            )}
            <Box marginTop={1}>
              {tableRow(
                <Text bold dimColor>SOUND</Text>,
                <Text bold dimColor>{`PLAYS WHEN${isSound ? '' : '  (muted: ▶ still plays)'}`}</Text>,
              )}
            </Box>
            {SOUNDS.map(sound =>
              tableRow(
                <Button key={`play-${sound.cue}`} label={`▶ ${sound.label}`} onPress={() => void testSound($, sound.cue)} />,
                <Text>{sound.when}</Text>,
              ),
            )}
          </Box>
        )}
        <Box flexDirection="column">
          {/* Three columns: labels and info at their natural width, bars take the rest. */}
          <Box flexDirection="row" columnGap={GAP}>
            <Box flexDirection="column" flexShrink={0}>
              {tip('tip-cache', TIPS.cache, cell(label('CACHE')))}
              {tip('tip-context', TIPS.context, cell(label('CONTEXT')))}
              {where !== null && tip('tip-race', TIPS.race, cell(label('RACE')))}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={10}>
              {tip(
                'tip-cache-bar',
                cacheDetail,
                bar(at === null ? 0 : cacheFrac, cLevel, `Prompt cache: ${cacheText}`, at === null || left <= 0, [0, FIVE_MIN / life.ms]),
                { top: 1, left: 0 },
              )}
              {tip(
                'tip-context-bar',
                contextDetail,
                bar(pct / 100, xLevel, `Context: ${ctxText}`, c === null, [0.85, 1], [0.7, 0.85]),
                { top: 1, left: 0 },
              )}
              {where !== null &&
                cell(
                  Svg !== undefined ? (
                    <Svg
                      source={svgRace(where.progress / 100, px, RED, YELLOW)}
                      alt={`Race distance: ${where.progress}%`}
                      height={14}
                    />
                  ) : (
                    <Text>
                      <Text color={RED}>{textRace(where.progress / 100, cells - 4).done}</Text>
                      🏎️
                      <Text dimColor>{textRace(where.progress / 100, cells - 4).todo}</Text>
                      🏁
                    </Text>
                  ),
                )}
            </Box>
            <Box flexDirection="column" flexShrink={0}>
              {cell(
                <Text color={at === null || left <= 0 ? undefined : THEME[cLevel]} dimColor={at === null}>
                  {cacheText}
                </Text>,
              )}
              {cell(
                <Text color={c === null ? undefined : THEME[xLevel]} dimColor={c === null}>
                  {ctxText}
                </Text>,
              )}
              {where !== null &&
                cell(
                  <Text color={RED} bold>
                    {raceInfo}
                  </Text>,
                )}
            </Box>
          </Box>
          {where !== null && (
            <Box paddingLeft={LABEL + GAP}>
              <Text italic wrap="truncate-end">{`📻 "${where.radio}"`}</Text>
            </Box>
          )}
        </Box>
        {isNudge && (
          <Text color="warning">
            {pct >= 85
              ? `📻 Context ${pct}% full. Box, box: Handoff or Compact before it auto-compacts.`
              : `📻 Box, box! Cache expires in ${clockText(left)} with context ${pct}% full. Handoff or Compact now.`}
          </Text>
        )}
        {isPitting && <Text color="warning">🔧 In the pits: compacting the conversation. The pitwall's buttons are back once it's done.</Text>}
        <Box flexDirection="row" columnGap={3} rowGap={1} flexWrap="wrap" alignItems="center">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color={THEME[hLevel]}>{doing === 'handoff' ? '◌' : '●'}</Text>
            <Button
              key="handoff"
              label={handoffLabel}
              dimColor={isLocked}
              variant={hLevel === 'hot' && !isLocked ? 'primary' : undefined}
              onPress={() => void openForm($, 'handoff')}
            />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color={THEME[xLevel]}>{isPitting ? '◌' : '●'}</Text>
            <Button
              key="compact"
              label={compactLabel}
              dimColor={isLocked}
              variant={xLevel === 'hot' && !isLocked ? 'primary' : undefined}
              onPress={() => void openForm($, 'compact')}
            />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color="success">{doing === 'commit' ? '◌' : '✅'}</Text>
            <Button key="self-commit" label={commitLabel} dimColor={isLocked} onPress={() => void openForm($, 'commit')} />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color={RED}>🔥</Text>
            <Button key="grill" label="Grill me" dimColor={compacting || doing === 'compact'} onPress={() => void openForm($, 'grill')} />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color="suggestion">{doing === 'eli5' ? '◌' : '🧒'}</Text>
            <Button key="eli5" label={eli5Label} dimColor={isLocked} onPress={() => void openForm($, 'eli5')} />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color={RED}>{doing === 'awty' ? '◌' : '📻'}</Text>
            <Button key="awty" label={awtyLabel} dimColor={isLocked} onPress={() => void openForm($, 'radio')} />
          </Box>
          {resume !== null && (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Text color="suggestion">↩</Text>
              <Button
                key="resume"
                label="Resume from last handoff"
                dimColor={isPitting}
                onPress={() => void doResume($)}
              />
            </Box>
          )}
          {where !== null && (
            <Button
              key="trip-details"
              label={isOpen ? '▾ hide telemetry' : '▸ telemetry'}
              plain
              dimColor
              onPress={() => void update($, isTripOpen, open => !open)}
            />
          )}
          {where !== null && (
            <Button
              key="clear-trip"
              label="✕ clear"
              plain
              dimColor
              onPress={() => void update($, trip, (): Trip | null => null)}
            />
          )}
        </Box>
        {card === 'handoff' &&
          doing !== 'handoff' &&
          confirm(
            'handoff',
            `📋 Write a handoff to .handoff/ for the next session${c === null ? '' : `, summarizing ${kTokens(c.tokens)} of context`}? ` +
              'Add a focus to tailor it to what comes next.',
            [
              <Button key="handoff-write" variant="primary" label="📋 Write handoff" onPress={() => void runForm($, () => doHandoff($))} />,
              <Button key="handoff-focus" label="✏️ With a focus…" onPress={() => void typeInPrompt($, '/handoff')} />,
            ],
          )}
        {card === 'compact' &&
          confirm(
            'compact',
            `🔧 Compact the conversation now${c === null ? '' : ` (context ${pct}% used)`}? Claude summarizes it to free up room; ` +
              'detail from earlier turns may be lost, so Handoff first if you want to keep it.',
            [<Button key="compact-go" variant="primary" label="🔧 Compact now" onPress={() => void runForm($, () => doCompact($))} />],
          )}
        {card === 'commit' &&
          confirm(
            'commit',
            '✅ Check your repo(s) for uncommitted changes and ask Claude, in the chat, for a commit message per repo? ' +
              'Claude will not commit; it notes that you committed everything so far.',
            [<Button key="commit-go" variant="primary" label="✅ Check repos and ask" onPress={() => void runForm($, () => doSelfCommit($))} />],
          )}
        {card === 'grill' &&
          confirm('grill', '🔥 Have Claude interview you, round by round, until the plan holds up?', [
            <Button
              key="grill-start"
              variant="primary"
              label="🔥 Grill the current plan"
              onPress={() => void runForm($, async () => $.ui.toast(`🔥 ${await doGrill($, '')}`))}
            />,
            <Button key="grill-topic" label="✏️ Pick a topic…" onPress={() => void typeInPrompt($, '/mattpocock-skills:grilling')} />,
          ])}
        {card === 'eli5' &&
          confirm('eli5', "🧒 Explain like you're 5: plain words, an analogy and a tiny example. Which one?", [
            <Button key="eli5-last" label="🧒 Explain the last answer" onPress={() => void runForm($, () => doEli5($, 'last'))} />,
            <Button key="eli5-session" label="🗺️ Explain where we are" onPress={() => void runForm($, () => doEli5($, 'session'))} />,
          ])}
        {card === 'radio' &&
          confirm('radio', '📻 Ask the pit wall where we stand? You get progress toward the goal, a one-line status and 3 questions to ask next.', [
            <Button key="radio-go" variant="primary" label="📻 Radio check" onPress={() => void runForm($, () => doAwty($))} />,
          ])}
        {note !== null && (
          <Box flexDirection="column" rowGap={1} borderStyle="round" borderColor="success" paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{`📋 Handoff saved to .handoff/${note.name}. Start the next chat with:`}</Text>
              <Button
                key="resume-close"
                plain
                dimColor
                label="✕ close"
                onPress={() => void update($, resumeNote, (): ResumeNote | null => null)}
              />
            </Box>
            <Markdown key="resume-text" text={'```\n' + note.text + '\n```'} />
            <Box flexDirection="row">
              <Button key="resume-copy" variant="primary" label="📋 Copy" onPress={press => void copyResume($, press.surface)} />
            </Box>
          </Box>
        )}
        {shown !== null && (
          <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{`🧒 ${shown.title}`}</Text>
              <Button
                key="eli5-close"
                plain
                dimColor
                label="✕ close"
                onPress={() => void update($, explained, (): Explained | null => null)}
              />
            </Box>
            <Markdown key="eli5-text" text={shown.text} />
          </Box>
        )}
        {where !== null && isOpen && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text>
              <Text bold>Race goal </Text>
              {where.goal}
            </Text>
            <Text>
              <Text bold>Now </Text>
              {where.status}
            </Text>
            {where.journey.map(j => (
              <Text dimColor>• {j}</Text>
            ))}
            {where.blockers.map(b => (
              <Text color="warning">🟡 {b}</Text>
            ))}
          </Box>
        )}
        {where !== null && where.questions.length > 0 && (
          <Box flexDirection="column">
            {where.questions.map((q, i) => (
              <Box flexDirection="row" gap={1}>
                <Text color={RED}>▶</Text>
                <Button key={`q${i}`} label={q} plain onPress={() => void $.prompt.fill({ text: q })} />
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
