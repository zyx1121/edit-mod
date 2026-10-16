import { expect, test } from 'claude-code/testing'

import {
  applyEdits, backspace, dedent, findAll, mapSpot, move, newline, nextMatch, replaceRange, textIn, typeText,
} from '../hooks/editor/model'
import { cells, colAt, wordAt } from '../hooks/editor/text'

test('replaceRange splices across lines and reports the end', async () => {
  const result = replaceRange(['abc', 'def'], { row: 0, col: 1 }, { row: 1, col: 2 }, 'X\nY')
  expect(result.lines).toEqual(['aX', 'Yf'])
  expect(result.end).toEqual({ row: 1, col: 1 })
})

test('mapSpot moves spots after an edit', async () => {
  const from = { row: 0, col: 2 }
  const to = { row: 0, col: 2 }
  expect(mapSpot({ row: 0, col: 5 }, from, to, { row: 1, col: 0 })).toEqual({ row: 1, col: 3 })
  expect(mapSpot({ row: 2, col: 1 }, from, to, { row: 1, col: 0 })).toEqual({ row: 3, col: 1 })
  expect(mapSpot({ row: 0, col: 1 }, from, to, { row: 1, col: 0 })).toEqual({ row: 0, col: 1 })
})

test('typing at 3 carets on one line edits each of them', async () => {
  const carets = [{ row: 0, col: 1 }, { row: 0, col: 3 }, { row: 0, col: 5 }]
  const result = applyEdits(['abcdef'], carets, typeText('-'))
  expect(result.lines).toEqual(['a-bc-de-f'])
  expect(result.carets).toEqual([{ row: 0, col: 2 }, { row: 0, col: 5 }, { row: 0, col: 8 }])
})

test('a newline at one caret moves the carets below it', async () => {
  const carets = [{ row: 0, col: 2 }, { row: 1, col: 1 }]
  const result = applyEdits(['  ab', 'cd'], carets, newline)
  expect(result.lines).toEqual(['  ', '  ab', 'c', 'd'])
  expect(result.carets).toEqual([{ row: 1, col: 2 }, { row: 3, col: 0 }])
})

test('backspace at line starts joins lines for every caret', async () => {
  const carets = [{ row: 1, col: 0 }, { row: 2, col: 0 }]
  const result = applyEdits(['a', 'b', 'c'], carets, backspace)
  expect(result.lines).toEqual(['abc'])
  expect(result.carets).toEqual([{ row: 0, col: 1 }, { row: 0, col: 2 }])
})

test('typing replaces each selection', async () => {
  const carets = [
    { row: 0, col: 3, anchor: { row: 0, col: 0 } },
    { row: 1, col: 3, anchor: { row: 1, col: 0 } },
  ]
  const result = applyEdits(['foo bar', 'foo baz'], carets, typeText('qux'))
  expect(result.lines).toEqual(['qux bar', 'qux baz'])
})

test('dedent keeps the caret on its text', async () => {
  const result = applyEdits(['    x'], [{ row: 0, col: 4 }], dedent('  '))
  expect(result.lines).toEqual(['  x'])
  expect(result.carets).toEqual([{ row: 0, col: 2 }])
})

test('Left on a selection collapses it to its start', async () => {
  const caret = { row: 0, col: 4, anchor: { row: 0, col: 1 } }
  expect(move(['abcdef'], caret, 'left', 10, false)).toEqual({ row: 0, col: 1 })
  expect(move(['abcdef'], caret, 'left', 10, true)).toEqual({ row: 0, col: 3, anchor: { row: 0, col: 1 } })
})

test('findAll matches case-insensitively, across lines too', async () => {
  const lines = ['Foo foo', 'bar foo', 'baz']
  expect(findAll(lines, 'foo')).toHaveLength(3)
  const across = findAll(lines, 'foo\nbar')
  expect(across).toEqual([{ from: { row: 0, col: 4 }, to: { row: 1, col: 3 } }])
  expect(textIn(lines, across[0]!)).toBe('foo\nbar')
})

test('nextMatch wraps in both directions', async () => {
  const matches = findAll(['a x a', 'a'], 'a')
  expect(nextMatch(matches, { row: 1, col: 1 }, false)).toEqual(matches[0])
  expect(nextMatch(matches, { row: 0, col: 0 }, true)).toEqual(matches[2])
})

test('wide characters take 2 cells', async () => {
  expect(cells('a中b')).toBe(4)
  expect(colAt('a中b', 3)).toBe(2)
  expect(wordAt('const 中文 = 1', 7)).toEqual([6, 8])
})
