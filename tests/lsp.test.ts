import { expect, test } from 'claude-code/testing'

import { editsByPath, hasLsp, hoverText, pathOf, toDiagnostic, toItems } from '../hooks/lsp'

const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
})

test('a language server diagnostic maps to 1-based lines and a severity', async () => {
  const found = toDiagnostic({ range: range(2, 4, 9), severity: 2, code: 6133, message: '`x` is never used\u001b[0m' })
  expect(found).toEqual({
    line: 3,
    col: 5,
    endLine: 3,
    endCol: 10,
    severity: 'warning',
    code: '6133',
    message: '`x` is never used',
  })
})

test('completion items sort by sortText and lose snippet placeholders', async () => {
  const items = toItems({
    isIncomplete: false,
    items: [
      { label: 'toUpperCase', sortText: '2', insertText: 'toUpperCase()' },
      { label: 'at', sortText: '1', textEdit: { range: range(0, 9, 10), newText: 'at(${1:index})$0' }, detail: 'method\nmore' },
    ],
  })
  expect(items).toEqual([
    { label: 'at', insert: 'at(index)', detail: 'method', from: { row: 0, col: 9 }, to: { row: 0, col: 10 } },
    { label: 'toUpperCase', insert: 'toUpperCase()' },
  ])
  expect(toItems([{ label: 'x' }])).toEqual([{ label: 'x', insert: 'x' }])
  expect(toItems(undefined)).toEqual([])
})

test('hover text drops code fences', async () => {
  expect(hoverText({ contents: { kind: 'markdown', value: '```tsx\nconst s: "hi"\n```\n' } })).toBe('const s: "hi"')
  expect(hoverText({ contents: ['plain', { language: 'ts', value: 'let x' }] })).toBe('plain\nlet x')
  expect(hoverText(undefined)).toBe('')
})

test('a rename groups its edits by file, documentChanges first', async () => {
  const both = editsByPath({
    changes: { 'file:///w/a.ts': [{ range: range(0, 16, 21), newText: 'yell' }] },
    documentChanges: [{ textDocument: { uri: 'file:///w/b%20c.ts' }, edits: [{ range: range(2, 0, 5), newText: 'yell' }] }],
  })
  // A server that sends both forms means the same edits: they apply once
  expect([...both.keys()]).toEqual(['/w/b c.ts'])
  const changes = editsByPath({ changes: { 'file:///w/a.ts': [{ range: range(0, 16, 21), newText: 'yell' }] } })
  expect(changes.get('/w/a.ts')).toEqual([{ from: { row: 0, col: 16 }, to: { row: 0, col: 21 }, text: 'yell' }])
  expect(pathOf('file:///w/b%20c.ts')).toBe('/w/b c.ts')
})

test('only files a language server takes have LSP features', async () => {
  expect(hasLsp('/w/a.ts')).toBe(true)
  expect(hasLsp('/w/a.PY')).toBe(true)
  expect(hasLsp('/w/a.txt')).toBe(false)
})
