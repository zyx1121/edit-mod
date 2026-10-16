// Pure helpers for lines of text and the terminal cells they take.

export function split(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function indentUnit(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)

  return name.endsWith('.go') || name === 'Makefile' ? '\t' : '  '
}

// What a line draws as: tabs as 2 spaces, control characters as a middle dot
export function show(line: string): string {
  return line.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, '\u00b7')
}

export function cellWidth(ch: string): number {
  if (ch === '\t') return 2

  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
}

export function cells(text: string): number {
  let used = 0
  for (const ch of text) used += cellWidth(ch)

  return used
}

// The column under a cell offset, rounding to the nearer side of a wide character
export function colAt(line: string, at: number): number {
  let used = 0
  for (let i = 0; i < line.length; i++) {
    const w = cellWidth(line[i] ?? '')
    if (used + w / 2 > at) return i
    used += w
  }

  return line.length
}

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_$]/u.test(ch)
}

// The word around a column: [start, end), empty where no word touches it
export function wordAt(line: string, col: number): [number, number] {
  let start = col
  let end = col
  if (!isWordChar(line[col]) && isWordChar(line[col - 1])) start = end = col - 1
  if (!isWordChar(line[start])) return [col, col]
  while (start > 0 && isWordChar(line[start - 1])) start--
  while (end < line.length && isWordChar(line[end])) end++

  return [start, end]
}

export function wordLeft(line: string, col: number): number {
  let c = col
  while (c > 0 && /\s/.test(line[c - 1] ?? '')) c--
  while (c > 0 && isWordChar(line[c - 1])) c--
  if (c === col && c > 0) c--

  return c
}

export function wordRight(line: string, col: number): number {
  let c = col
  while (c < line.length && /\s/.test(line[c] ?? '')) c++
  while (c < line.length && isWordChar(line[c])) c++
  if (c === col && c < line.length) c++

  return c
}
