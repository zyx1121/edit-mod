import { expect, test } from 'claude-code/testing'

import { applyEdits, typeText } from '../hooks/editor/model'
import { applyOps, batch, diffOps, fullTextOps, mapCarets, PIECE } from '../hooks/editor/sync'
import { split } from '../hooks/editor/text'

// A small seeded generator, so a failure repeats
function random(seed: number): () => number {
  let x = seed
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    return x / 0x100000000
  }
}

function roundTrip(prev: string[], next: string[]): void {
  const ops = diffOps(prev, next)
  expect(applyOps(prev, ops)).toEqual(next)
}

test('diffOps rebuilds the next text after 500 random edits', async () => {
  const rand = random(7)
  const alphabet = ['a', 'b', ' ', '\n', '中', '']
  let lines = split('alpha\nbeta\n\ngamma')
  for (let i = 0; i < 500; i++) {
    const row = Math.floor(rand() * lines.length)
    const col = Math.floor(rand() * ((lines[row] ?? '').length + 1))
    const endRow = Math.min(lines.length - 1, row + Math.floor(rand() * 2))
    const endCol = endRow === row
      ? col + Math.floor(rand() * ((lines[row] ?? '').length - col + 1))
      : Math.floor(rand() * ((lines[endRow] ?? '').length + 1))
    const text = Array.from({ length: Math.floor(rand() * 4) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('')
    const caret = { row: endRow, col: endCol, anchor: { row, col } }
    const next = applyEdits(lines, [caret], typeText(text)).lines
    roundTrip(lines, next)
    lines = next
  }
})

test('diffOps handles lines added and removed at both ends', async () => {
  roundTrip(['a', 'b'], ['x', 'a', 'b'])
  roundTrip(['a', 'b'], ['a', 'b', 'x'])
  roundTrip(['a', 'b', 'c'], ['a'])
  roundTrip(['a', 'b', 'c'], ['c'])
  roundTrip(['a'], [''])
  roundTrip([''], ['a', 'b'])
})

test('a large replacement splits into pieces that fit a post', async () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`)
  const ops = diffOps([''], big)
  expect(ops.length).toBeGreaterThan(1)
  for (const op of ops) expect('reset' in op ? 0 : op.text.length).toBeLessThanOrEqual(PIECE)
  expect(applyOps([''], ops)).toEqual(big)
})

test('fullTextOps rebuilds from any mirror, batch by batch', async () => {
  const text = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`)
  let outbox = fullTextOps(text)
  let mirror: string[] | undefined = ['stale', 'mirror']
  while (outbox.length > 0) {
    const taken = batch(outbox)
    outbox = outbox.slice(taken.length)
    mirror = applyOps(mirror!, taken)
  }
  expect(mirror).toEqual(text)
})

test('applyOps refuses an op outside the text', async () => {
  expect(applyOps(['ab'], [{ from: { row: 0, col: 5 }, to: { row: 0, col: 5 }, text: 'x' }])).toBeUndefined()
  expect(applyOps(['ab'], [{ from: { row: 1, col: 0 }, to: { row: 1, col: 0 }, text: 'x' }])).toBeUndefined()
})

test('mapCarets keeps a caret at the end of a line that a formatter changed', async () => {
  const prev = ['const a = {b:1} // a']
  const next = ['const a = { b: 1 }; // a']
  const [moved] = mapCarets([{ row: 0, col: 20 }], diffOps(prev, next), next)
  expect(moved).toEqual({ row: 0, col: 24 })
})
