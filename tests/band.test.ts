import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

test('the F1 band draws cache, context and the three buttons on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pitwall', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /CACHE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /GREEN FLAG/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /FERRARI/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /PITWALL/ })).toBeDefined()
    expect(await ui.find({ key: 'tip-cache' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Prompt cache: time until it expires/ })).toBeDefined()
    expect(await ui.find({ key: 'legend' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Green flag: nothing is cached yet.*Nothing to do, keep going\.$/ })).toBeDefined()
    expect((await ui.find({ key: 'handoff' }))?.props.label).toBe('📋 Handoff')
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect(await ui.find({ key: 'awty' })).toBeDefined()
    expect(await ui.find({ key: 'self-commit' })).toBeDefined()
    expect(await ui.find({ key: 'notify' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band yields to a survey', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)
  const ui = await $.ui.mount({
    plugin: 'pitwall',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  await ui.unmount()
})

test('the legend spells out every racing name', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const ui = await $.ui.mount({ plugin: 'pitwall', surface: 'terminal', ...BAND })
  await ui.press({ key: 'legend' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(texts).toContain('Summarizes the conversation to free up context')
  expect(texts).toContain('Writes a detailed file to .handoff/')
  for (const cue of ['radio', 'flyby', 'pitstop']) {
    expect(await ui.find({ key: `play-${cue}` })).toBeDefined()
  }
  expect(await ui.find({ key: 'play-lights-out' })).toBeUndefined()
  expect(await ui.find({ key: 'play-purple' })).toBeUndefined()
  await ui.unmount()
})
