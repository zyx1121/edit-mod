import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A change larger than one post goes up in pieces. These tests open another
// file while those pieces are still on their way, which flushes the first one.

const LINE = 'abcdefghij'.repeat(9)
const SOURCE = Array.from({ length: 2000 }, (_, i) => `${i} ${LINE}`).join('\n')

const PANE_PROPS = {
  title: 'a.txt',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

type World = { writes: string[] }

function world(on: On): World {
  const state: World = { writes: [] }
  let disk = SOURCE
  mock.env(on, { HOME: '/home' })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: disk }))
  on('fs.write', ($, e) => {
    state.writes.push(e.text)
    disk = e.text
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  return state
}

const RUN = { presentation: { isFullscreen: true, columns: 160 } }

test('a flush waits for the pieces still on their way', async ($, on) => {
  const clock = mock.clock(on)
  const state = world(on)
  await $.command.run({ command: 'edit', args: 'a.txt', ...RUN } as never)
  const ui = await $.ui.mount({ plugin: 'edit-mod', surface: 'terminal', component: 'Pane', requestId: 'editor', props: PANE_PROPS as never })
  await ui.resize({ columns: 60, rows: 12, in: 'editor' })

  await ui.key({ key: 'a', meta: true, in: 'editor' })
  await ui.key({ key: 'x', in: 'editor' })
  await ui.advance(1000)
  // The undo brings back 190889 characters: 4 pieces, and the flush starts at once
  await ui.key({ key: 'z', meta: true, in: 'editor' })

  const opening = $.command.run({ command: 'edit', args: 'b.txt', ...RUN } as never)
  await clock.advance(2500)
  await opening
  await ui.unmount()

  // Never half a change and never the cut text from before the undo
  expect(state.writes.length).toBeGreaterThan(0)
  for (const text of state.writes) expect(text === SOURCE).toBe(true)
})

test('a flush never writes a change whose last piece did not come', async ($, on) => {
  const clock = mock.clock(on)
  const state = world(on)
  await $.command.run({ command: 'edit', args: 'a.txt', ...RUN } as never)
  const ui = await $.ui.mount({ plugin: 'edit-mod', surface: 'terminal', component: 'Pane', requestId: 'editor', props: PANE_PROPS as never })
  await ui.resize({ columns: 60, rows: 12, in: 'editor' })

  // The first piece of a change, with more to come; the rest never arrives
  const start = { row: 0, col: 0 }
  await ui.post({ type: 'sync', seq: Date.now() * 2, base: 1, ops: [{ from: start, to: start, text: 'partial ' }], more: true, isActive: true })

  const opening = $.command.run({ command: 'edit', args: 'b.txt', ...RUN } as never)
  await clock.advance(2500)
  await opening
  await ui.unmount()

  expect(state.writes.map(text => text.length)).toEqual([])
})

test('a flush writes a change once its last piece came', async ($, on) => {
  const clock = mock.clock(on)
  const state = world(on)
  await $.command.run({ command: 'edit', args: 'a.txt', ...RUN } as never)
  const ui = await $.ui.mount({ plugin: 'edit-mod', surface: 'terminal', component: 'Pane', requestId: 'editor', props: PANE_PROPS as never })
  await ui.resize({ columns: 60, rows: 12, in: 'editor' })

  const start = { row: 0, col: 0 }
  const seq = Date.now() * 2
  await ui.post({ type: 'sync', seq, base: 1, ops: [{ from: start, to: start, text: 'one ' }], more: true, isActive: true })
  await ui.post({ type: 'sync', seq: seq + 1, base: 1, ops: [{ from: { row: 0, col: 4 }, to: { row: 0, col: 4 }, text: 'two ' }], isActive: true })

  const opening = $.command.run({ command: 'edit', args: 'b.txt', ...RUN } as never)
  await clock.advance(2500)
  await opening
  await ui.unmount()

  expect(state.writes.at(-1)?.startsWith('one two 0 abc')).toBe(true)
})

test('a flush after every piece landed writes the whole text', async ($, on) => {
  const clock = mock.clock(on)
  const state = world(on)
  await $.command.run({ command: 'edit', args: 'a.txt', ...RUN } as never)
  const ui = await $.ui.mount({ plugin: 'edit-mod', surface: 'terminal', component: 'Pane', requestId: 'editor', props: PANE_PROPS as never })
  await ui.resize({ columns: 60, rows: 12, in: 'editor' })

  await ui.key({ key: 'a', meta: true, in: 'editor' })
  await ui.key({ key: 'x', in: 'editor' })
  await ui.advance(1000)
  await ui.key({ key: 'z', meta: true, in: 'editor' })
  await ui.advance(250)
  await ui.advance(250)
  await ui.advance(2000)

  const opening = $.command.run({ command: 'edit', args: 'b.txt', ...RUN } as never)
  await clock.advance(2500)
  await opening
  await ui.unmount()

  expect(state.writes.at(-1)?.length).toBe(SOURCE.length)
  expect(state.writes.at(-1) === SOURCE).toBe(true)
})
