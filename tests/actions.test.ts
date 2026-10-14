import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 14,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 13 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }

// An in-memory project at /proj, standing for the file system and the session.
const world = (on: On, files: Record<string, string>) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 12, 15, 30) })
  on('session.root', () => ({ value: '/proj' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 50_000, percent: 25 }, rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: Object.keys(files).some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  return files
}

test('Handoff writes a dated file in .handoff/ and ignores the folder once', async ($, on) => {
  const files = world(on, { '/proj/.gitignore': 'node_modules/\n' })
  on('model.fork', () => ({ value: { isAnswered: true, text: '# Handoff: Retry logic for uploads\n\n## Goal\nShip it.', usage: USAGE } }))

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'terminal', ...BAND })
  await ui.press({ key: 'handoff' })
  await ui.press({ key: 'handoff-write' })
  await ui.press({ key: 'handoff' })
  await ui.press({ key: 'handoff-write' })

  const written = Object.keys(files).filter(p => p.startsWith('/proj/.handoff/'))
  expect(written.length).toBe(1)
  expect(written[0]).toMatch(/\/proj\/\.handoff\/\d{4}-\d{2}-\d{2}-\d{4}-retry-logic-for-uploads\.md$/)
  expect(files[written[0]!]).toContain('## How to resume')
  expect(files['/proj/.gitignore']).toBe('node_modules/\n\n# Session handoffs (pitwall)\n.handoff/\n')
  await ui.unmount()
})

test('Radio check draws race progress and three question chips that fill the prompt', async ($, on) => {
  world(on, {})
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('model.fork', () => ({ value: {
    isAnswered: true,
    text: JSON.stringify({
      goal: 'Ship retries',
      progress: 60,
      status: 'Tests are green',
      radio: 'Good pace, tests are green. Box for docs next lap.',
      journey: ['Wrote retry', 'Added tests'],
      blockers: [],
      questions: ['What about timeouts?', 'Should we add jitter?', 'Ready to open a PR?'],
    }),
    usage: USAGE,
  } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pitwall', surface, ...BAND })
    await ui.press({ key: 'awty' })
    await ui.press({ key: 'radio-go' })
    expect(await ui.find({ type: 'Text', text: /LAP 30\/50/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Box for docs next lap/ })).toBeDefined()
    expect(await ui.find({ key: 'q2' })).toBeDefined()
    await ui.press({ key: 'q1' })
    await ui.unmount()
  }
  expect(filled).toContain('Should we add jitter?')
})

test('Self commit asks Claude in the chat for a message per repo with changes', async ($, on) => {
  world(on, {})
  const asked: string[] = []
  on('session.repo', () => ({ value: { root: '/proj', remote: null, isOwn: false } as never }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const args = e.argv.join(' ')
    const stdout = args.includes('status')
      ? '## main...origin/main\n M src/retry.ts\n?? src/jitter.ts\n'
      : args.includes('diff')
        ? ' src/retry.ts | 12 ++++++++----\n 1 file changed, 8 insertions(+), 4 deletions(-)\n'
        : ''
    return { value: { exitCode: 0, stdout, stderr: '' } as never }
  })
  on('prompt.submit', ($, e) => {
    asked.push(e.text)
    return { text: e.text }
  })

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'self-commit' })
  await ui.press({ key: 'commit-go' })
  await ui.unmount()

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain("[Self commit] I'm committing the work so far myself")
  expect(asked[0]).toContain('Repo: . (branch main...origin/main)')
  expect(asked[0]).toContain(' M src/retry.ts')
  expect(asked[0]).toContain('?? src/jitter.ts')
  expect(asked[0]).toContain('1 file changed')
})

test('Handoff takes a focus from /handoff, and asks for suggested skills', async ($, on) => {
  const files = world(on, {})
  const prompts: string[] = []
  const filled: string[] = []
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: '# Handoff: Retry logic\n\n## Suggested skills\n- tdd', usage: USAGE } }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  // The card's ✏️ puts the command in the prompt box, where the focus is typed.
  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'handoff' })
  expect(await ui.findAll({ type: 'Input' })).toHaveLength(0)
  await ui.press({ key: 'handoff-focus' })
  expect(filled).toEqual(['/handoff '])
  expect(await ui.find({ key: 'handoff-write' })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'handoff', args: 'add jitter to retries' } as never)
  expect(prompts[0]).toContain('## Suggested skills')
  expect(prompts[0]).toContain('Do not duplicate content already captured')
  expect(prompts[0]).toContain('The next session will focus on: add jitter to retries')
  const written = Object.keys(files).filter(p => p.startsWith('/proj/.handoff/'))
  expect(files[written[0]!]).toContain('**Next session focus:** add jitter to retries')
})

test('Grill me runs the grilling skill on the current plan, or types it in the prompt box', async ($, on) => {
  world(on, {})
  const ran: { command: string; args?: string }[] = []
  const filled: string[] = []
  on('command.run', ($, e) => {
    ran.push({ command: e.command, args: e.args })
    return {}
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'grill' })
  await ui.press({ key: 'grill-start' })
  await ui.press({ key: 'grill' })
  await ui.press({ key: 'grill-topic' })
  await ui.unmount()

  expect(ran).toEqual([
    { command: 'mattpocock-skills:grilling', args: 'Grill me on the plan we have so far in this conversation.' },
  ])
  expect(filled).toEqual(['/mattpocock-skills:grilling '])
})

test('ELI5 explains in a card that closes', async ($, on) => {
  world(on, {})
  on('model.fork', () => ({ value: { isAnswered: true, text: 'A cache is like a fridge.\n\n**In one line:** keep it cold.', usage: USAGE } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pitwall', surface, ...BAND })
    await ui.press({ key: 'eli5' })
    await ui.press({ key: 'eli5-session' })
    expect(await ui.find({ type: 'Text', text: /Where we are, simply/ })).toBeDefined()
    expect((await ui.find({ key: 'eli5-text' }))?.props.text).toContain('like a fridge')
    await ui.press({ key: 'eli5-close' })
    expect(await ui.find({ key: 'eli5-text' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Handoff will not open its form while a handoff is being written', async ($, on) => {
  world(on, {})
  let release: () => void = () => {}
  on('model.fork', () => new Promise(done => {
    release = () => done({ value: { isAnswered: true, text: '# Handoff: Slow one', usage: USAGE } })
  }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'handoff' })
  const writing = ui.press({ key: 'handoff-write' })
  // Let the handoff start; the kit's environment has the web timer, its types do not.
  const timer = (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout
  await new Promise<void>(done => timer(done, 20))
  await ui.press({ key: 'handoff' })
  expect(await ui.find({ key: 'handoff-focus' })).toBeUndefined()
  expect(toasts.some(t => t.includes('Writing the handoff… hang on'))).toBe(true)
  release()
  await writing
  await ui.unmount()
})

test('After a handoff, the resume prompt shows on the strip and copies to the clipboard', async ($, on) => {
  world(on, {})
  on('model.fork', () => ({ value: { isAnswered: true, text: '# Handoff: Retry logic', usage: USAGE } }))
  const copied: string[] = []
  // The surface refuses the copy, as a remote one may: the OS tool takes it.
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } as never }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'wl-copy') copied.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'handoff' })
  await ui.press({ key: 'handoff-write' })
  const text = (await ui.find({ key: 'resume-text' }))?.props.text as string
  expect(text).toMatch(/Pick up where the last session left off\. Read @\.handoff\/\d{4}-\d{2}-\d{2}-\d{4}-retry-logic\.md first/)
  await ui.press({ key: 'resume-copy' })
  expect(copied.length).toBe(1)
  expect(text).toContain(copied[0]!)
  await ui.press({ key: 'resume-close' })
  expect(await ui.find({ key: 'resume-text' })).toBeUndefined()
  await ui.unmount()
})

test('Every action button opens a confirm card first; Cancel runs nothing', async ($, on) => {
  world(on, {})
  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  const cards = [
    ['handoff', 'handoff-write'],
    ['compact', 'compact-go'],
    ['self-commit', 'commit-go'],
    ['grill', 'grill-start'],
    ['eli5', 'eli5-last'],
    ['awty', 'radio-go'],
  ] as const
  for (const [button, go] of cards) {
    await ui.press({ key: button })
    expect(await ui.find({ key: go })).toBeDefined()
    const cancel = (await ui.findAll({ type: 'Button' })).find(b => b.props.label === 'Cancel')
    await ui.press({ key: cancel!.key! })
    expect(await ui.find({ key: go })).toBeUndefined()
  }
  // Each Cancel closed its card with nothing run: no handoff was written.
  expect(await ui.find({ key: 'resume-text' })).toBeUndefined()
  await ui.unmount()
})

test('Compact falls back to Claude Code\'s own /compact where the direct call is refused', async ($, on) => {
  world(on, {})
  const ran: string[] = []
  const filled: string[] = []
  on('command.run', ($, e) => {
    ran.push(e.command)
    return {}
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  // Nothing beneath answers session.compact here, so the direct call is refused, as in the desktop app.

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact-go' })
  await ui.unmount()

  expect(ran).toEqual(['compact'])
  expect(filled).toEqual([])
})

test('When every route is refused, Compact leaves /compact in the prompt box and says so', async ($, on) => {
  world(on, {})
  const filled: string[] = []
  const toasts: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact-go' })
  await ui.unmount()

  expect(filled).toEqual(['/compact'])
  expect(toasts.some(t => t.includes('/compact is in the prompt box, press Enter') && !t.includes('pitwall: pitwall'))).toBe(true)
})

const SUMMARY = { role: 'user', text: 'Summary of the work so far.', toolUses: [] }

test('While the conversation is compacting, every action button is locked', async ($, on) => {
  world(on, {})
  let finish: () => void = () => {}
  on('session.compact', () => new Promise(done => {
    finish = () => done({ messages: [SUMMARY], tokensBefore: 900_000, tokensAfter: 120_000 } as never)
  }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'desktop', ...BAND })
  // A compaction started elsewhere (a typed /compact) is in progress.
  const compacting = $.session.compact({ messages: [SUMMARY] } as never)
  const timer = (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout
  await new Promise<void>(done => timer(done, 20))

  expect(await ui.find({ type: 'Text', text: /In the pits: compacting the conversation/ })).toBeDefined()
  for (const key of ['handoff', 'compact', 'self-commit', 'grill', 'eli5', 'awty']) {
    expect((await ui.find({ key }))?.props.dimColor).toBe(true)
    await ui.press({ key })
  }
  expect(await ui.findAll({ type: 'Button' }).then(all => all.filter(b => b.props.label === 'Cancel'))).toHaveLength(0)
  expect(toasts.filter(t => t.includes("Compacting… the pitwall's back")).length).toBe(6)

  finish()
  await compacting
  expect(await ui.find({ type: 'Text', text: /In the pits/ })).toBeUndefined()
  expect((await ui.find({ key: 'handoff' }))?.props.dimColor).toBeFalsy()
  expect(toasts.some(t => t.startsWith('🔧 Pit stop complete'))).toBe(true)
  await ui.unmount()
})
