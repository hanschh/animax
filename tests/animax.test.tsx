import { expect, mock, test } from 'claude-code/testing'

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

test('in the terminal the spinner line is kept whole, with the bot and label beside it', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Flibbertigibbeting/ }))?.text).toBe('Flibbertigibbeting…')
  expect(await ui.find({ type: 'Text', text: 'cooking code' })).toBeDefined()
  await ui.unmount()
})

test('in the editor the spinner line is left alone', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.js', old_string: 'a', new_string: 'b' })

  for (const surface of ['vscode', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SPINNER, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toEqual(['Flibbertigibbeting…'])
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
    const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    await ui.unmount()
  }
})

test('the video is a Raster by the terminal spinner and an Svg in the editor pane', async ($, on) => {
  if (!VIDEO) return // assets not built: the ASCII fallback is covered above
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: '/x/hello.js', content: '' })

  const term = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(await term.find({ type: 'Raster' })).toBeDefined()
  await term.unmount()

  const editor = await $.ui.mount({ ...PANE, surface: 'vscode' })
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

test('the pane draws the character with its label beside it, on every surface', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: '/x/hello.js', content: '' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'COOKING CODE' })).toBeDefined()
    await ui.unmount()
  }
})

test('an idle pane says it is waiting', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'IDLE' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'waiting for your prompt' })).toBeDefined()
    await ui.unmount()
  }
})

test('/animax mute and unmute save without a /config row', async ($, on) => {
  mock.store(on)
  expect((await $.command.run({ command: 'animax', args: 'mute' } as never)).text).toBe('animax muted.')
  expect((await $.command.run({ command: 'animax', args: 'sound' } as never)).text).toContain('off')
  expect((await $.command.run({ command: 'animax', args: 'unmute' } as never)).text).toBe('animax sound on.')
  expect((await $.command.run({ command: 'animax', args: 'sound' } as never)).text).toContain('on')
})

test('/animax mute also sets the /config row where a surface lists it', async ($, on) => {
  mock.store(on)
  const saved: unknown[] = []
  // A plugin installed from a marketplace names its rows <name>@<marketplace>.<field>.
  on('config.list', () => ({ value: [{ key: 'animax@hanschh.sound', label: 'animax sound', kind: 'boolean', value: true, isLocked: false }] as never }))
  on('config.set', (_$, e) => {
    saved.push(`${e.key}=${String(e.value)}`)
    return { value: e.value }
  })
  await $.command.run({ command: 'animax', args: 'mute' } as never)
  expect(saved).toEqual(['animax@hanschh.sound=false'])
})

test('/animax mute still mutes when nothing can be saved', async $ => {
  const muted = await $.command.run({ command: 'animax', args: 'mute' } as never)
  expect(muted.text).toContain('animax muted.')
  expect(muted.text).toContain('Only for this session')
  expect((await $.command.run({ command: 'animax', args: 'sound' } as never)).text).toContain('off')
})

test('a saved mute holds in the next session', async ($, on) => {
  mock.store(on, { sound: false })
  on('command.register', () => ({ value: undefined as never }))
  on('session.start', (_$, e) => e as never)
  await $.session.start({ source: 'startup', cwd: '/x', surface: null, isInteractive: true } as never)
  expect((await $.command.run({ command: 'animax', args: 'sound' } as never)).text).toContain('off')
})

test('/animax toggles the pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  expect((await $.command.run({ command: 'animax', args: '' } as never)).text).toContain('opened')
  expect((await $.command.run({ command: 'animax', args: '' } as never)).text).toContain('closed')
})

function audioWorld(on: TestOn) {
  engine(on)
  const clock = mock.clock(on)
  const plays: string[] = []
  on('session.info', () => ({ value: { platform: 'macos' } as never }))
  on('audio.play', (_$, e) => {
    plays.push(String((e as { clip?: unknown }).clip ?? 'clip'))
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  return { clock, plays }
}

test('sound plays while Claude works', async ($, on) => {
  const { clock, plays } = audioWorld(on)
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.js', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(plays.length).toBeGreaterThan(0)
})

test('closing the pane stops the sound until it is opened again', async ($, on) => {
  const { clock, plays } = audioWorld(on)
  await $.command.run({ command: 'animax', args: '' } as never) // open
  await $.command.run({ command: 'animax', args: '' } as never) // close
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.js', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(plays).toEqual([])

  await $.command.run({ command: 'animax', args: '' } as never) // open again
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(1000)
  expect(plays.length).toBeGreaterThan(0)
})

// ~/.animax/video as /animax video leaves it: the person's own clips, over the built-in ones.
function customWorld(on: TestOn, failure?: string) {
  engine(on)
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  const runs: string[][] = []
  // The engine hands the hooks a path in the platform's own spelling.
  const files = new Map<string, string>()
  const key = (p: string) => p.replace(/[\\/]+/g, '/')
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (failure) return { value: { exitCode: 1, stdout: '', stderr: `animax build-assets: ${failure}` } as never }
    const out = e.argv.find(a => a.startsWith('--out='))!.slice('--out='.length)
    const coding = { ...VIDEO!.states.coding, svg: '<svg id="mine"/>', audio: 'audio/coding.wav' }
    files.set(key(`${out}/video.json`), JSON.stringify({ fps: 8, source: e.argv[2], states: { coding } }))
    return { value: { exitCode: 0, stdout: 'coding    <- Me - Cooking.mp4\nno video for: idle\n', stderr: '' } as never }
  })
  on('fs.stat', (_$, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } as never }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text as never }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(key(e.path)) }))
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  return { runs }
}

async function paneSvg($: Parameters<Extract<Parameters<typeof test>[1], (...args: any[]) => any>>[0]) {
  await $.tool.call({ tool: 'Write', file_path: '/x/hello.js', content: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  return String((svg as { props?: { source?: string } } | undefined)?.props?.source ?? '')
}

test('/animax video builds the person\'s own character and draws it', async ($, on) => {
  if (!VIDEO) return
  const { runs } = customWorld(on)
  const built = await $.command.run({ command: 'animax', args: 'video "D:/My Videos/Slime" --seconds=6' } as never)
  expect(built.text).toContain('your character is in')
  expect(built.text).toContain('Me - Cooking.mp4')
  expect(runs[0]!.slice(2)).toEqual(['D:/My Videos/Slime', '--seconds=6', '--out=C:/Users/me/.animax/video'])
  expect(await paneSvg($)).toContain('mine')

  expect((await $.command.run({ command: 'animax', args: 'video' } as never)).text).toContain('your own')
  expect((await $.command.run({ command: 'animax', args: 'video reset' } as never)).text).toContain('built-in')
  expect(await paneSvg($)).not.toContain('mine')
})

test('/animax video says why a build failed', async ($, on) => {
  customWorld(on, 'no videos found in D:/empty')
  const failed = await $.command.run({ command: 'animax', args: 'video D:/empty' } as never)
  expect(failed.text).toContain('no videos found')
  expect(failed.text).toContain('/animax video <folder>')
})
