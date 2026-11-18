import { expect, test } from 'claude-code/testing'

import { VIDEO } from '../assets/video.mjs'

const SPINNER = {
  plugin: 'animax',
  component: 'Spinner',
  props: { word: 'Flibbertigibbeting', message: null, suffix: '…', mode: 'tool-use' },
} as const

const PANE = {
  plugin: 'animax',
  component: 'Pane',
  requestId: 'animax',
  props: {
    title: 'animax',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: any[]) => any>>[1]

// Hooks registered with `on` stand for the engine beneath the plugin.
function engine(on: TestOn) {
  on('tool.call', () => ({ result: {} }))
  // The engine's own spinner line.
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.word}${e.props.suffix}`}</Text>
  })
}

const SURFACES = ['terminal', 'vscode'] as const

test('the engine spinner line is kept whole, with the animation and label beside it', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.js', old_string: 'a', new_string: 'b' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...SPINNER, surface })
    expect((await ui.find({ type: 'Text', text: /Flibbertigibbeting/ }))?.text).toBe('Flibbertigibbeting…')
    expect(await ui.find({ type: 'Text', text: 'cooking code' })).toBeDefined()
    await ui.unmount()
  }
})

test('each tool maps to its state', async ($, on) => {
  engine(on)
  const cases = [
    [{ tool: 'Bash', command: 'npm test' }, 'debugging'],
    [{ tool: 'TodoWrite', todos: [] }, 'planning'],
    [{ tool: 'Grep', pattern: 'x' }, 'thinking'],
  ] as const
  for (const [call, label] of cases) {
    await $.tool.call(call as never)
    const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    await ui.unmount()
  }
})

test('the video is a Raster in the terminal and an Svg in the editor', async ($, on) => {
  if (!VIDEO) return // assets not built: the ASCII fallback is covered above
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: '/x/hello.js', content: '' })

  const term = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(await term.find({ type: 'Raster' })).toBeDefined()
  await term.unmount()

  const editor = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  expect(await editor.find({ type: 'Svg' })).toBeDefined()
  await editor.unmount()
})

test('position below puts the animation under the spinner line', { options: { position: 'below' } }, async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const word = texts.findIndex(t => t.includes('Flibbertigibbeting'))
  const label = texts.indexOf('cooking code')
  expect(word).toBeGreaterThanOrEqual(0)
  expect(label).toBeGreaterThan(word)
  await ui.unmount()
})

test('the pane draws the character with its label, on every surface', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: '/x/hello.js', content: '' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /COOKING CODE/ })).toBeDefined()
    await ui.unmount()
  }
})
