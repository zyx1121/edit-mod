// The editing model: carets with optional selections over an array of lines.
// Every edit is a range replacement, so one or many carets take the same path.

import { split, wordLeft, wordRight } from './text'

export type Spot = { row: number; col: number }

export type Caret = Spot & { anchor?: Spot }

export type Range = { from: Spot; to: Spot }

// One caret's edit: replace `from`..`to` with `text`. The caret lands after the
// text, or with `isKept` it keeps its place, mapped through the edit.
export type Edit = Range & { text: string; isKept?: boolean }

export function compare(a: Spot, b: Spot): number {
  return a.row - b.row || a.col - b.col
}

export function clamp(lines: readonly string[], spot: Spot): Spot {
  const row = Math.max(0, Math.min(lines.length - 1, spot.row))
  const col = Math.max(0, Math.min((lines[row] ?? '').length, spot.col))

  return { row, col }
}

export function rangeOf(caret: Caret): Range | undefined {
  const anchor = caret.anchor
  if (!anchor || compare(anchor, caret) === 0) return undefined

  return compare(anchor, caret) < 0
    ? { from: anchor, to: { row: caret.row, col: caret.col } }
    : { from: { row: caret.row, col: caret.col }, to: anchor }
}

export function textIn(lines: readonly string[], range: Range): string {
  const rows = lines.slice(range.from.row, range.to.row + 1)
  const last = rows.length - 1

  return rows
    .map((line, i) => line.slice(i === 0 ? range.from.col : 0, i === last ? range.to.col : undefined))
    .join('\n')
}

export function replaceRange(
  lines: readonly string[],
  from: Spot,
  to: Spot,
  text: string,
): { lines: string[]; end: Spot } {
  const head = (lines[from.row] ?? '').slice(0, from.col)
  const tail = (lines[to.row] ?? '').slice(to.col)
  const parts = split(text)
  const last = parts.length - 1
  const middle = parts.map((part, i) => (i === 0 ? head : '') + part + (i === last ? tail : ''))
  const next = lines.slice(0, from.row).concat(middle, lines.slice(to.row + 1))
  const end = { row: from.row + last, col: (last === 0 ? head.length : 0) + (parts[last] ?? '').length }

  return { lines: next, end }
}

// Where a spot after an edit lands once `from`..`to` became text ending at `end`
export function mapSpot(spot: Spot, from: Spot, to: Spot, end: Spot): Spot {
  if (compare(spot, from) <= 0) return spot
  if (compare(spot, to) < 0) return end
  if (spot.row === to.row) return { row: end.row, col: end.col + spot.col - to.col }

  return { row: spot.row + end.row - to.row, col: spot.col }
}

function mapCaret(caret: Caret, from: Spot, to: Spot, end: Spot): Caret {
  const spot = mapSpot(caret, from, to, end)
  const anchor = caret.anchor && mapSpot(caret.anchor, from, to, end)

  return anchor ? { ...spot, anchor } : spot
}

function startOf(caret: Caret): Spot {
  return rangeOf(caret)?.from ?? caret
}

// Applies one edit per caret, last caret first, so each edit leaves the
// positions before it alone and the carets after it are mapped through it
export function applyEdits(
  lines: readonly string[],
  carets: readonly Caret[],
  make: (lines: readonly string[], caret: Caret, index: number) => Edit | undefined,
): { lines: string[]; carets: Caret[]; isChanged: boolean } {
  const order = carets.map((_, i) => i).sort((a, b) => compare(startOf(carets[b]!), startOf(carets[a]!)))
  let next = lines.slice()
  const placed: Caret[] = carets.slice()
  const done: number[] = []
  let isChanged = false
  for (const i of order) {
    const edit = make(next, placed[i]!, i)
    if (edit) {
      const result = replaceRange(next, edit.from, edit.to, edit.text)
      next = result.lines
      isChanged = true
      placed[i] = edit.isKept ? mapCaret({ row: placed[i]!.row, col: placed[i]!.col }, edit.from, edit.to, result.end) : result.end
      for (const j of done) placed[j] = mapCaret(placed[j]!, edit.from, edit.to, result.end)
    }
    done.push(i)
  }

  return { lines: next, carets: merge(placed), isChanged }
}

// Drops carets that landed on the same spot; the first one stays the primary
export function merge(carets: readonly Caret[]): Caret[] {
  const seen = new Set<string>()

  return carets.filter(caret => {
    const key = `${caret.row}:${caret.col}`
    if (seen.has(key)) return false
    seen.add(key)

    return true
  })
}

// Edits that each caret applies for itself

export function typeText(text: string) {
  return (_: readonly string[], caret: Caret): Edit => {
    const range = rangeOf(caret) ?? { from: caret, to: caret }

    return { ...range, text }
  }
}

export function newline(lines: readonly string[], caret: Caret): Edit {
  const range = rangeOf(caret) ?? { from: caret, to: caret }
  const indent = /^\s*/.exec(lines[range.from.row] ?? '')?.[0] ?? ''

  return { ...range, text: '\n' + indent }
}

export function backspace(lines: readonly string[], caret: Caret): Edit | undefined {
  const range = rangeOf(caret)
  if (range) return { ...range, text: '' }
  if (caret.col > 0) return { from: { row: caret.row, col: caret.col - 1 }, to: caret, text: '' }
  if (caret.row === 0) return undefined

  return { from: { row: caret.row - 1, col: (lines[caret.row - 1] ?? '').length }, to: caret, text: '' }
}

export function deleteForward(lines: readonly string[], caret: Caret): Edit | undefined {
  const range = rangeOf(caret)
  if (range) return { ...range, text: '' }
  const length = (lines[caret.row] ?? '').length
  if (caret.col < length) return { from: caret, to: { row: caret.row, col: caret.col + 1 }, text: '' }
  if (caret.row >= lines.length - 1) return undefined

  return { from: caret, to: { row: caret.row + 1, col: 0 }, text: '' }
}

export function deleteWordBack(lines: readonly string[], caret: Caret): Edit | undefined {
  const range = rangeOf(caret)
  if (range) return { ...range, text: '' }
  if (caret.col === 0) return backspace(lines, caret)

  return { from: { row: caret.row, col: wordLeft(lines[caret.row] ?? '', caret.col) }, to: caret, text: '' }
}

export function killToEnd(lines: readonly string[], caret: Caret): Edit | undefined {
  const range = rangeOf(caret)
  if (range) return { ...range, text: '' }
  const length = (lines[caret.row] ?? '').length
  if (caret.col < length) return { from: caret, to: { row: caret.row, col: length }, text: '' }

  return deleteForward(lines, caret)
}

export function killToStart(lines: readonly string[], caret: Caret): Edit | undefined {
  const range = rangeOf(caret)
  if (range) return { ...range, text: '' }
  if (caret.col === 0) return backspace(lines, caret)

  return { from: { row: caret.row, col: 0 }, to: caret, text: '' }
}

export function dedent(unit: string) {
  return (lines: readonly string[], caret: Caret): Edit | undefined => {
    const line = lines[caret.row] ?? ''
    const cut = line.startsWith(unit) ? unit.length : line.startsWith(' ') ? 1 : 0
    if (cut === 0) return undefined

    return { from: { row: caret.row, col: 0 }, to: { row: caret.row, col: cut }, text: '', isKept: true }
  }
}

// Moves

export type Motion =
  | 'left' | 'right' | 'up' | 'down' | 'home' | 'end'
  | 'wordLeft' | 'wordRight' | 'docStart' | 'docEnd' | 'pageUp' | 'pageDown'

export function move(lines: readonly string[], caret: Caret, motion: Motion, page: number, isExtending: boolean): Caret {
  const range = rangeOf(caret)
  // Left and Right on a selection collapse it to its edge, as in a macOS text field
  if (range && !isExtending && (motion === 'left' || motion === 'right')) {
    const edge = motion === 'left' ? range.from : range.to

    return { row: edge.row, col: edge.col }
  }
  const line = lines[caret.row] ?? ''
  const { row, col } = caret
  let to: Spot
  switch (motion) {
    case 'left': to = col > 0 ? { row, col: col - 1 } : { row: row - 1, col: Infinity }; break
    case 'right': to = col < line.length ? { row, col: col + 1 } : row < lines.length - 1 ? { row: row + 1, col: 0 } : caret; break
    case 'up': to = { row: row - 1, col }; break
    case 'down': to = { row: row + 1, col }; break
    case 'home': to = { row, col: 0 }; break
    case 'end': to = { row, col: line.length }; break
    case 'wordLeft': to = { row, col: wordLeft(line, col) }; break
    case 'wordRight': to = { row, col: wordRight(line, col) }; break
    case 'docStart': to = { row: 0, col: 0 }; break
    case 'docEnd': to = { row: Infinity, col: Infinity }; break
    case 'pageUp': to = { row: row - page, col }; break
    case 'pageDown': to = { row: row + page, col }; break
  }
  if (row === 0 && motion === 'left' && col === 0) to = caret
  const spot = clamp(lines, to)
  const anchor = isExtending ? (caret.anchor ?? { row, col }) : undefined

  return anchor ? { ...spot, anchor } : spot
}

// Search

export function findAll(lines: readonly string[], query: string, limit = 2000): Range[] {
  if (query === '') return []
  const found: Range[] = []
  const needle = query.toLowerCase()
  if (!query.includes('\n')) {
    for (let row = 0; row < lines.length && found.length < limit; row++) {
      const hay = (lines[row] ?? '').toLowerCase()
      let at = hay.indexOf(needle)
      while (at >= 0 && found.length < limit) {
        found.push({ from: { row, col: at }, to: { row, col: at + query.length } })
        at = hay.indexOf(needle, at + Math.max(1, query.length))
      }
    }

    return found
  }
  const parts = split(needle)
  for (let row = 0; row + parts.length - 1 < lines.length && found.length < limit; row++) {
    const first = (lines[row] ?? '').toLowerCase()
    const head = parts[0] ?? ''
    if (!first.endsWith(head)) continue
    const isMatch = parts.slice(1).every((part, i) => {
      const line = (lines[row + 1 + i] ?? '').toLowerCase()
      return i === parts.length - 2 ? line.startsWith(part) : line === part
    })
    if (isMatch) {
      found.push({
        from: { row, col: first.length - head.length },
        to: { row: row + parts.length - 1, col: (parts[parts.length - 1] ?? '').length },
      })
    }
  }

  return found
}

// The first match at or after `spot`, wrapping to the top; backwards with `isBack`
export function nextMatch(matches: readonly Range[], spot: Spot, isBack: boolean): Range | undefined {
  if (matches.length === 0) return undefined
  if (isBack) {
    for (let i = matches.length - 1; i >= 0; i--) if (compare(matches[i]!.from, spot) < 0) return matches[i]

    return matches[matches.length - 1]
  }

  return matches.find(match => compare(match.from, spot) >= 0) ?? matches[0]
}
