// The editor and the hooks keep the same text: the editor sends each change as
// range ops, and the hooks apply them to their mirror of the document.
// Props and posts hold 100000 characters, so text moves in pieces of PIECE.

import type { Op, Spot } from '../../types'
import { clamp, mapSpot, replaceRange } from './model'
import type { Caret } from './model'

export const PIECE = 60_000

// Where the caret lands after typing `text` at `spot`
export function advance(spot: Spot, text: string): Spot {
  const breaks = text.split('\n')
  if (breaks.length === 1) return { row: spot.row, col: spot.col + text.length }

  return { row: spot.row + breaks.length - 1, col: (breaks[breaks.length - 1] ?? '').length }
}

// One replacement as ops whose text fits a post: the first replaces the range,
// the rest append after it
function pieces(from: Spot, to: Spot, text: string): Op[] {
  if (text.length <= PIECE) return [{ from, to, text }]
  const ops: Op[] = []
  let at = from
  for (let i = 0; i < text.length; i += PIECE) {
    const part = text.slice(i, i + PIECE)
    ops.push(i === 0 ? { from, to, text: part } : { from: at, to: at, text: part })
    at = advance(i === 0 ? from : at, part)
  }

  return ops
}

// The ops that turn `prev` into `next`: one replacement over the lines between
// their common head and tail, narrowed to the changed characters on one line
export function diffOps(prev: readonly string[], next: readonly string[]): Op[] {
  if (prev === next) return []
  let head = 0
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++
  let tail = 0
  while (
    tail < prev.length - head && tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) tail++
  const gone = prev.slice(head, prev.length - tail)
  const added = next.slice(head, next.length - tail)
  if (gone.length === 0 && added.length === 0) return []

  if (gone.length === 1 && added.length === 1) {
    const a = gone[0]!
    const b = added[0]!
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    let s = 0
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

    return pieces({ row: head, col: p }, { row: head, col: a.length - s }, b.slice(p, b.length - s))
  }
  if (gone.length === 0) {
    const text = added.join('\n')
    if (head < prev.length) return pieces({ row: head, col: 0 }, { row: head, col: 0 }, text + '\n')
    const end = { row: head - 1, col: (prev[head - 1] ?? '').length }

    return pieces(end, end, '\n' + text)
  }
  const last = head + gone.length - 1
  if (added.length === 0) {
    if (last + 1 < prev.length) return [{ from: { row: head, col: 0 }, to: { row: last + 1, col: 0 }, text: '' }]

    return [{ from: { row: head - 1, col: (prev[head - 1] ?? '').length }, to: { row: last, col: (prev[last] ?? '').length }, text: '' }]
  }

  return pieces({ row: head, col: 0 }, { row: last, col: (prev[last] ?? '').length }, added.join('\n'))
}

// Ops that rebuild the whole text from nothing
export function fullTextOps(lines: readonly string[]): Op[] {
  const start = { row: 0, col: 0 }

  return [{ reset: true }, ...pieces(start, start, lines.join('\n'))]
}

function isInside(lines: readonly string[], spot: Spot): boolean {
  return spot.row >= 0 && spot.row < lines.length && spot.col >= 0 && spot.col <= (lines[spot.row] ?? '').length
}

// Applies ops to a mirror; undefined when an op does not fit the text
export function applyOps(lines: readonly string[], ops: readonly Op[]): string[] | undefined {
  let next = lines.slice()
  for (const op of ops) {
    if ('reset' in op) {
      next = ['']
      continue
    }
    const isOrdered = op.from.row < op.to.row || (op.from.row === op.to.row && op.from.col <= op.to.col)
    if (!isInside(next, op.from) || !isInside(next, op.to) || !isOrdered) return undefined
    next = replaceRange(next, op.from, op.to, op.text).lines
  }

  return next
}

// Carries carets through ops, as an edit by someone else moves them
export function mapCarets(carets: readonly Caret[], ops: readonly Op[], lines: readonly string[]): Caret[] {
  const moved = carets.map(caret => {
    let spot = { row: caret.row, col: caret.col }
    for (const op of ops) {
      if ('reset' in op) return { row: 0, col: 0 }
      spot = mapSpot(spot, op.from, op.to, advance(op.from, op.text))
    }

    return spot
  })

  return moved.map(spot => clamp(lines, spot))
}

// Takes ops from the front of `outbox` until their text fills one post
export function batch(outbox: readonly Op[]): Op[] {
  const taken: Op[] = []
  let size = 0
  for (const op of outbox) {
    const length = 'reset' in op ? 0 : op.text.length
    if (taken.length > 0 && size + length > PIECE) break
    taken.push(op)
    size += length
  }

  return taken
}
