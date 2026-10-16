import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { Doc, EditorProps } from '../types'
import { hashText } from './hash'

type Snapshot = { lines: string[]; row: number; col: number }

type Spot = { row: number; col: number }

type Selection = { from: Spot; to: Spot; text: string }

type State = {
  lines: string[]
  row: number
  col: number
  top: number
  rev: number
  isDirty: boolean
  editedAt: number
  inflight?: string
  undo: Snapshot[]
  snappedAt: number
  doc: Doc
  wasFocused: boolean
  wheelSeq: number
  pasteSeq: number
  anchor?: Spot
}

type Surface = ClientSurface<State>

// The terminal's own background (Ghostty `background`), painted over the pane's
// shade so the editor matches the transcript.
const BACKGROUND = '#000000'
const WHEEL_ROWS = 3
const UNDO_DEPTH = 100
const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert',
])

function split(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

function indentUnit(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.endsWith('.go') || name === 'Makefile' ? '\t' : '  '
}

function show(line: string): string {
  return line.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, '\u00b7')
}

function showCol(line: string, col: number): number {
  return show(line.slice(0, col)).length
}

function cellWidth(ch: string): number {
  if (ch === '\t') return 2

  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
}

function colAt(line: string, cells: number): number {
  let used = 0
  for (let i = 0; i < line.length; i++) {
    const w = cellWidth(line[i] ?? '')
    if (used + w / 2 > cells) return i
    used += w
  }

  return line.length
}

function isBefore(a: Spot, b: Spot): boolean {
  return a.row < b.row || (a.row === b.row && a.col < b.col)
}

function selected(state: State): Selection | undefined {
  const anchor = state.anchor
  if (!anchor || (anchor.row === state.row && anchor.col === state.col)) return undefined
  const here = { row: state.row, col: state.col }
  const [from, to] = isBefore(anchor, here) ? [anchor, here] : [here, anchor]
  const rows = state.lines.slice(from.row, to.row + 1)
  const last = rows.length - 1
  const text = rows
    .map((line, i) => line.slice(i === 0 ? from.col : 0, i === last ? to.col : undefined))
    .join('\n')

  return { from, to, text }
}

function editRows(s: Surface, doc: Doc): number {
  const shown = Math.min(3, doc.diagnostics.length)

  return Math.max(1, (s.rows || 20) - 1 - shown)
}

function follow(state: State, rows: number): State {
  let top = state.top
  if (state.row < top) top = state.row
  if (state.row >= top + rows) top = state.row - rows + 1

  return { ...state, top: Math.max(0, top) }
}

function snap(state: State): State {
  const now = Date.now()
  if (now - state.snappedAt < 700) return { ...state, snappedAt: now }
  const undo = [...state.undo, { lines: state.lines, row: state.row, col: state.col }]

  return { ...state, undo: undo.slice(-UNDO_DEPTH), snappedAt: now }
}

function edited(state: State, lines: string[], row: number, col: number): State {
  return { ...snap(state), lines, row, col, isDirty: true, editedAt: Date.now(), anchor: undefined }
}

function insert(state: State, text: string): State {
  const { lines, row, col } = state
  const line = lines[row] ?? ''
  const parts = split(text)
  const head = line.slice(0, col)
  const tail = line.slice(col)
  const next = [...lines]
  if (parts.length === 1) {
    next[row] = head + text + tail

    return edited(state, next, row, col + text.length)
  }
  const last = parts[parts.length - 1] ?? ''
  const middle = parts.slice(1, -1)
  next.splice(row, 1, head + (parts[0] ?? ''), ...middle, last + tail)

  return edited(state, next, row + parts.length - 1, last.length)
}

function newline(state: State): State {
  const line = state.lines[state.row] ?? ''
  const indent = /^\s*/.exec(line)?.[0] ?? ''

  return insert(state, '\n' + indent)
}

function backspace(state: State): State {
  const { lines, row, col } = state
  const line = lines[row] ?? ''
  const next = [...lines]
  if (col > 0) {
    next[row] = line.slice(0, col - 1) + line.slice(col)

    return edited(state, next, row, col - 1)
  }
  if (row === 0) return state
  const above = lines[row - 1] ?? ''
  next.splice(row - 1, 2, above + line)

  return edited(state, next, row - 1, above.length)
}

function forwardDelete(state: State): State {
  const { lines, row, col } = state
  const line = lines[row] ?? ''
  const next = [...lines]
  if (col < line.length) {
    next[row] = line.slice(0, col) + line.slice(col + 1)

    return edited(state, next, row, col)
  }
  if (row >= lines.length - 1) return state
  next.splice(row, 2, line + (lines[row + 1] ?? ''))

  return edited(state, next, row, col)
}

function dedent(state: State, unit: string): State {
  const line = state.lines[state.row] ?? ''
  const cut = line.startsWith(unit) ? unit.length : line.startsWith(' ') ? 1 : 0
  if (cut === 0) return state
  const next = [...state.lines]
  next[state.row] = line.slice(cut)

  return edited(state, next, state.row, Math.max(0, state.col - cut))
}

function killLine(state: State): State {
  const line = state.lines[state.row] ?? ''
  if (state.col >= line.length) return forwardDelete(state)
  const next = [...state.lines]
  next[state.row] = line.slice(0, state.col)

  return edited(state, next, state.row, state.col)
}

function killToStart(state: State): State {
  if (state.col === 0) return backspace(state)
  const next = [...state.lines]
  next[state.row] = (state.lines[state.row] ?? '').slice(state.col)

  return edited(state, next, state.row, 0)
}

function deleteWord(state: State): State {
  if (state.col === 0) return backspace(state)
  const to = wordStep(state, -1).col
  const line = state.lines[state.row] ?? ''
  const next = [...state.lines]
  next[state.row] = line.slice(0, to) + line.slice(state.col)

  return edited(state, next, state.row, to)
}

function undo(state: State): State {
  const last = state.undo[state.undo.length - 1]
  if (!last) return state

  return {
    ...state,
    lines: last.lines,
    row: last.row,
    col: last.col,
    undo: state.undo.slice(0, -1),
    isDirty: true,
    editedAt: Date.now(),
    snappedAt: 0,
    anchor: undefined,
  }
}

function removeSelection(state: State, sel: Selection): State {
  const head = (state.lines[sel.from.row] ?? '').slice(0, sel.from.col)
  const tail = (state.lines[sel.to.row] ?? '').slice(sel.to.col)
  const next = [...state.lines]
  next.splice(sel.from.row, sel.to.row - sel.from.row + 1, head + tail)

  return edited(state, next, sel.from.row, sel.from.col)
}

function paste(state: State, text: string): State {
  const sel = selected(state)

  return insert(sel ? removeSelection(state, sel) : state, text)
}

function move(state: State, row: number, col: number): State {
  const r = Math.max(0, Math.min(state.lines.length - 1, row))
  const c = Math.max(0, Math.min((state.lines[r] ?? '').length, col))

  return { ...state, row: r, col: c, snappedAt: 0 }
}

function wordStep(state: State, dir: 1 | -1): State {
  const line = state.lines[state.row] ?? ''
  let c = state.col
  if (dir < 0) {
    while (c > 0 && /\s/.test(line[c - 1] ?? '')) c--
    while (c > 0 && /\w/.test(line[c - 1] ?? '')) c--
    if (c === state.col && c > 0) c--
  } else {
    while (c < line.length && /\s/.test(line[c] ?? '')) c++
    while (c < line.length && /\w/.test(line[c] ?? '')) c++
    if (c === state.col && c < line.length) c++
  }

  return move(state, state.row, c)
}

function keyed(state: State, k: ClientKeyEvent, page: number): State | 'save' {
  const unit = indentUnit(state.doc.path)
  const { row, col } = state
  const lineLength = (state.lines[row] ?? '').length

  // Ghostty and Terminal.app turn Cmd+arrows and Cmd/Option+Delete into these
  // readline keys, so they behave as in a macOS text field.
  if (k.ctrl) {
    if (k.key === 's') return 'save'
    if (k.key === 'z') return undo(state)
    if (k.key === 'a') return move(state, row, 0)
    if (k.key === 'e') return move(state, row, lineLength)
    if (k.key === 'k') return killLine(state)
    if (k.key === 'u') return killToStart(state)
    if (k.key === 'w' || k.key === 'backspace') return deleteWord(state)
    if (k.key === 'left') return wordStep(state, -1)
    if (k.key === 'right') return wordStep(state, 1)
    if (k.key === 'home') return move(state, 0, 0)
    if (k.key === 'end') return move(state, Infinity, Infinity)

    return state
  }
  if (k.meta) {
    if (k.key === 'left' || k.key === 'b') return wordStep(state, -1)
    if (k.key === 'right' || k.key === 'f') return wordStep(state, 1)
    if (k.key === 'up') return move(state, 0, 0)
    if (k.key === 'down') return move(state, Infinity, Infinity)
    if (k.key === 'backspace') return deleteWord(state)
    if (k.key === 'z') return undo(state)
    if (k.key === 's') return 'save'
  }

  switch (k.key) {
    case 'up': return move(state, row - 1, col)
    case 'down': return move(state, row + 1, col)
    case 'left': return col > 0 ? move(state, row, col - 1) : move(state, row - 1, Infinity)
    case 'right': return col < lineLength ? move(state, row, col + 1) : move(state, row + 1, 0)
    case 'home': return move(state, row, 0)
    case 'end': return move(state, row, lineLength)
    case 'pageup': return move(state, row - page, col)
    case 'pagedown': return move(state, row + page, col)
    case 'return':
    case 'enter': return newline(state)
    case 'backspace': return backspace(state)
    case 'delete': return forwardDelete(state)
    case 'tab': return k.shift ? dedent(state, unit) : insert(state, unit)
    case 'space': return insert(state, ' ')
  }
  if (NAMED.has(k.key) || k.meta) return state

  return insert(state, k.key)
}

type Outcome = { state: State; isSave?: true; copy?: string }

const MOVE_KEYS = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown'])
const DELETE_KEYS = new Set(['backspace', 'delete'])

function isMove(k: ClientKeyEvent): boolean {
  if (k.ctrl) return ['a', 'e', 'left', 'right', 'home', 'end'].includes(k.key)
  if (k.meta) return ['left', 'right', 'up', 'down', 'b', 'f'].includes(k.key)

  return MOVE_KEYS.has(k.key)
}

function isEdit(k: ClientKeyEvent): boolean {
  if (k.ctrl) return ['k', 'u', 'w', 'backspace'].includes(k.key)
  if (k.meta) return k.key === 'backspace'
  if (k.key === 'tab') return !k.shift

  return !NAMED.has(k.key) || ['return', 'enter', 'backspace', 'delete'].includes(k.key)
}

// Selection, copy and cut sit above the plain editing keys: Shift extends,
// Cmd+X and Cmd+C (sent as Option+X and Option+C) cut and copy, typing replaces.
function handle(state: State, k: ClientKeyEvent, page: number): Outcome {
  const sel = selected(state)
  if (k.meta && k.key === 'c') return { state, copy: sel?.text }
  if (k.meta && k.key === 'x') return sel ? { state: removeSelection(state, sel), copy: sel.text } : { state }
  if (k.meta && k.key === 'a') return { state: { ...move(state, Infinity, Infinity), anchor: { row: 0, col: 0 } } }
  if (isMove(k)) {
    const anchor = k.shift ? (state.anchor ?? { row: state.row, col: state.col }) : undefined
    const moved = keyed({ ...state, anchor: undefined }, k, page)

    return { state: { ...(moved === 'save' ? state : moved), anchor } }
  }
  if (sel && isEdit(k)) {
    const cleared = removeSelection(state, sel)
    const isDeleter = DELETE_KEYS.has(k.key) || (k.ctrl && k.key !== 'k') || (k.meta && k.key === 'backspace')
    if (isDeleter) return { state: cleared }
    const typed = keyed(cleared, k, page)

    return typed === 'save' ? { state: cleared, isSave: true } : { state: typed }
  }
  const result = keyed(state, k, page)

  return result === 'save' ? { state, isSave: true } : { state: result }
}

function save(s: Surface, state: State, isActive?: boolean): State {
  const text = state.lines.join('\n')
  s.post({ type: 'save', text, ...(isActive === undefined ? {} : { isActive }) })

  return { ...state, isDirty: false, inflight: text }
}

function scrollBy(state: State, by: number): State {
  const last = Math.max(0, state.lines.length - 1)

  return { ...state, top: Math.max(0, Math.min(last, state.top + by * WHEEL_ROWS)) }
}

function fresh(doc: Doc): State {
  return {
    lines: split(doc.text),
    row: 0,
    col: 0,
    top: 0,
    rev: doc.rev,
    isDirty: false,
    editedAt: 0,
    undo: [],
    snappedAt: 0,
    doc,
    wasFocused: false,
    wheelSeq: 0,
    pasteSeq: 0,
  }
}

function adopt(state: State, doc: Doc): State {
  const text = state.lines.join('\n')
  const textHash = hashText(text)
  const isOurSave = doc.savedHash !== undefined &&
    (doc.savedHash === textHash || (state.inflight !== undefined && doc.savedHash === hashText(state.inflight)))
  const isOtherFile = doc.path !== state.doc.path
  if (isOtherFile) return fresh(doc)

  const base = { ...state, rev: doc.rev, doc }
  if (isOurSave) {
    const isUntouched = textHash === doc.savedHash
    if (!isUntouched) return { ...base, inflight: undefined }
    const lines = split(doc.text)

    return { ...move({ ...base, lines }, state.row, state.col), inflight: undefined, isDirty: false }
  }
  if (state.isDirty || state.inflight !== undefined) return base
  const lines = split(doc.text)

  return move({ ...base, lines }, state.row, state.col)
}

function start(s: Surface, doc: Doc): State {
  s.onKey(k => {
    const current = s.state
    if (!current) return
    const rows = editRows(s, current.doc)
    const out = handle(current, k, rows - 1)
    if (out.isSave) {
      s.setState(follow(save(s, out.state, true), rows))
      return
    }
    if (out.copy !== undefined) s.post({ type: 'copy', text: out.copy, isActive: true })
    // The hooks keep the latest text so closing the pane can still save it
    else if (out.state.lines !== current.lines) s.post({ type: 'draft', text: out.state.lines.join('\n'), isActive: true })
    s.setState(follow(out.state, rows))
  })

  s.onPointer(e => {
    const current = s.state
    if (!current) return
    // No blur reaches a Client, so the pointer leaving the editor saves; the
    // editor stays the paste target until the person types into the prompt
    if (e.type === 'leave') {
      const isPending = current.isDirty && current.inflight === undefined
      if (isPending) s.setState(save(s, current))
      return
    }
    if (e.type === 'up') {
      const sel = selected(current)
      s.post(sel ? { type: 'copy', text: sel.text, isActive: true } : { type: 'active', isActive: true })
      return
    }
    if (e.button !== 'left' || (e.type !== 'down' && e.type !== 'move')) return

    const rows = editRows(s, current.doc)
    const gutter = String(current.lines.length).length + 1
    const row = Math.max(0, Math.min(current.lines.length - 1, current.top + e.y))
    const col = colAt(current.lines[row] ?? '', e.x - gutter)
    const here = { row: current.row, col: current.col }
    const anchor = e.type === 'down' && !e.shift ? { row, col } : (current.anchor ?? here)
    if (e.type === 'down') s.post({ type: 'active', isActive: true })
    s.setState(follow({ ...move(current, row, col), anchor }, rows))
  })

  return fresh(doc)
}

const Editor: ClientModule<EditorProps, State> = (props, s) => {
  const { Box, Text, Code } = s.elements
  const { isFocused, wheel, paste: pasted, ...doc } = props
  const initial = s.state ?? start(s, doc)
  let state = initial
  if (doc.rev > state.rev) state = follow(adopt(state, doc), editRows(s, doc))
  if (wheel && wheel.seq > state.wheelSeq) state = { ...scrollBy(state, wheel.by), wheelSeq: wheel.seq }
  if (pasted && pasted.seq > state.pasteSeq) {
    state = { ...follow(paste(state, pasted.text), editRows(s, doc)), pasteSeq: pasted.seq }
    s.post({ type: 'draft', text: state.lines.join('\n') })
  }
  if (isFocused !== undefined && isFocused !== state.wasFocused) {
    const isLeaving = state.wasFocused && !isFocused
    state = { ...(isLeaving && state.isDirty ? save(s, state) : state), wasFocused: isFocused }
  }
  if (state !== s.state) s.setState(state)

  const rows = editRows(s, state.doc)
  const top = Math.min(state.top, Math.max(0, state.lines.length - 1))
  const end = Math.min(state.lines.length, top + rows)
  const width = String(state.lines.length).length
  const errorLines = new Set(state.doc.diagnostics.map(d => d.line))
  const room = Math.max(4, (s.columns || 60) - width - 2)

  const gutter = []
  for (let i = top; i < end; i++) {
    const n = String(i + 1).padStart(width)
    const isError = errorLines.has(i + 1)
    gutter.push(
      <Text color={isError ? 'error' : undefined} dimColor={!isError} bold={i === state.row}>
        {n}
      </Text>,
    )
  }

  const asCode = (from: number, to: number) =>
    state.lines.slice(from, to).map(line => (line === '' ? ' ' : show(line))).join('\n')

  // Code grows into free room, so each run of lines is pinned to its own height
  const block = (from: number, to: number) => (
    <Box height={to - from} flexShrink={0} flexDirection="column">
      <Code source={asCode(from, to)} path={state.doc.path} wrap="truncate-end" />
    </Box>
  )

  const sel = selected(state)
  const isSpecial = (i: number) => i === state.row || (sel !== undefined && i >= sel.from.row && i <= sel.to.row)

  // One row drawn as plain text: the selection inverted, or the caret's cell
  const plainRow = (i: number) => {
    const line = state.lines[i] ?? ''
    const shown = show(line)
    if (sel && i >= sel.from.row && i <= sel.to.row) {
      const text = shown + ' '
      const from = i === sel.from.row ? showCol(line, sel.from.col) : 0
      const to = i === sel.to.row ? showCol(line, sel.to.col) : text.length

      return (
        <Text wrap="truncate-end">
          {text.slice(0, from)}
          <Text inverse>{text.slice(from, to)}</Text>
          {text.slice(to)}
        </Text>
      )
    }
    const at = showCol(line, state.col)
    const shift = Math.max(0, at - room + 2)

    return (
      <Text wrap="truncate-end">
        {shown.slice(shift, at)}
        <Text inverse>{shown[at] ?? ' '}</Text>
        {shown.slice(at + 1)}
      </Text>
    )
  }

  const parts = []
  let run = top
  for (let i = top; i < end; i++) {
    if (!isSpecial(i)) continue
    if (i > run) parts.push(block(run, i))
    parts.push(<Box height={1} flexShrink={0}>{plainRow(i)}</Box>)
    run = i + 1
  }
  if (end > run) parts.push(block(run, end))

  const first = state.doc.diagnostics.find(d => d.line === state.row + 1)
  const listed = [
    ...(first ? [first] : []),
    ...state.doc.diagnostics.filter(d => d !== first),
  ].slice(0, 3)

  const mark = state.isDirty ? 'unsaved' : state.inflight !== undefined ? 'saving' : state.doc.status
  const count = state.doc.diagnostics.length
  const name = state.doc.path.slice(state.doc.path.lastIndexOf('/') + 1)

  return (
    <Box flexDirection="column" height={s.rows || undefined} backgroundColor={BACKGROUND}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={width + 1}>{gutter}</Box>
        <Box flexDirection="column" flexGrow={1}>
          {parts}
        </Box>
      </Box>
      {listed.map(d => (
        <Text color="error" wrap="truncate-end">
          {d.line}:{d.col} {d.code} {d.message}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {name}  {state.row + 1}:{state.col + 1}  {mark}  {count === 0 ? 'no problems' : `${count} problems`}
      </Text>
    </Box>
  )
}

export default Editor
