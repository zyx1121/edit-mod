import { expect, mock, test } from 'claude-code/testing'

const FILE = '/proj/a.ts'
const SOURCE = 'const a = {b:1}'
const FORMATTED = 'const a = { b: 1 };\n'

const PANE_PROPS = {
  title: 'a.ts',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

test('saves only on Cmd+S or leaving the pane, formats, and lints', async ($, on) => {
  const writes: string[] = []
  const formatted: string[] = []
  let disk = SOURCE
  mock.env(on, { HOME: '/home' })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: disk }))
  on('fs.write', ($, e) => {
    writes.push(e.text)
    disk = e.text

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('process.run', ($, e) => {
    const isFmt = e.argv.includes('fmt')
    if (isFmt) formatted.push(e.init?.stdin ?? '')
    const stdout = isFmt
      ? FORMATTED
      : JSON.stringify({
        diagnostics: [{
          range: { start: { line: 1, col: 6 } },
          code: 'no-unused-vars',
          message: '`a` is never used',
        }],
      })

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ran = await $.command.run({
    command: 'edit',
    args: 'a.ts',
    presentation: { isFullscreen: true, columns: 160 },
  } as never)
  expect(ran.text).toContain(FILE)

  const ui = await $.ui.mount({
    plugin: 'edit-mod',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'editor',
    props: PANE_PROPS as never,
  })
  await ui.resize({ columns: 60, rows: 12, in: 'editor' })
  expect(await ui.find({ in: 'editor', text: /no-unused-vars/ })).toBeDefined()

  await ui.key({ key: 'end', in: 'editor' })
  await ui.key({ key: ' ', in: 'editor' })
  expect(await ui.find({ in: 'editor', text: /unsaved/ })).toBeDefined()
  expect(writes).toHaveLength(0)

  await ui.advance(5000)
  expect(writes).toHaveLength(0)

  await ui.key({ key: 's', meta: true, in: 'editor' })
  expect(writes).toEqual([FORMATTED])
  expect(await ui.find({ in: 'editor', text: /saved, formatted/ })).toBeDefined()

  await ui.key({ key: 'x', in: 'editor' })
  expect(writes).toHaveLength(1)
  await ui.redraw({ ...PANE_PROPS, isFocused: false } as never)
  expect(writes).toHaveLength(2)
  expect(formatted[1]).toContain('x')
  await ui.unmount()
})
