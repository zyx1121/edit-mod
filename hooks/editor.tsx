import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { Doc, EditorProps, EditorRequest, Op } from '../types'
import {
  applyEdits, backspace, clamp, compare, dedent, deleteForward, deleteWordBack, findAll, killToEnd,
  killToStart, merge, move, newline, nextMatch, rangeOf, textIn, typeText,
} from './editor/model'
import type { Caret, Edit, Motion, Range, Spot } from './editor/model'
import { batch, diffOps, fullTextOps, mapCarets } from './editor/sync'
import { cells, colAt, indentUnit, show, split, wordAt } from './editor/text'
import { hashText } from './hash'

type Snapshot = { lines: string[]; carets: Caret[] }

type Find = {
  isOpen: boolean
  hasKeys: boolean
  field: 'query' | 'replace'
  query: string
  replace: string
}

type Click = { at: number; row: number; col: number; count: number }

type Pending = { request: EditorRequest; sentAt: number; isSave: boolean; path: string }

type Loading = { rev: number; count: number; parts: string[]; index: number }

type State = {
  lines: string[]
  // carets[0] is the primary caret: the view follows it and the status shows it
  carets: Caret[]
  top: number
  isDirty: boolean
  undo: Snapshot[]
  redo: Snapshot[]
  snappedAt: number
  doc: Doc
  wasFocused: boolean
  wheelSeq: number
  pasteSeq: number
  find: Find
  click?: Click
  // The sync with the hooks: `sent` is the text the hooks hold once `outbox`
  // lands on version `base`; one request is out at a time
  base: number
  sent: string[]
  outbox: Op[]
  wantSave: boolean
  savingLines?: string[]
  seq: number
  pending?: Pending
  loading?: Loading
}

type Surface = ClientSurface<State>

type Outcome = { state: State; isSave?: true; copy?: string }

// The terminal's own background (Ghostty `background`), painted over the pane's
// shade so the editor matches the transcript.
const BACKGROUND = '#000000'
const MATCH_BACKGROUND = '#5c4b12'
const WHEEL_ROWS = 3
const UNDO_DEPTH = 100
const CLICK_MS = 400
const RESEND_MS = 1500
const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert',
])
const CLOSED_FIND: Find = { isOpen: false, hasKeys: false, field: 'query', query: '', replace: '' }

function primary(state: State): Caret {
  return state.carets[0] ?? { row: 0, col: 0 }
}

function editRows(s: Surface, state: { doc: Doc; find?: Find }): number {
  const shown = Math.min(3, state.doc.diagnostics.length) + (state.find?.isOpen ? 1 : 0)

  return Math.max(1, (s.rows || 20) - 1 - shown)
}

function follow(state: State, rows: number): State {
  const { row } = primary(state)
  let top = state.top
  if (row < top) top = row
  if (row >= top + rows) top = row - rows + 1

  return { ...state, top: Math.max(0, top) }
}

function withCarets(state: State, carets: Caret[]): State {
  return { ...state, carets: merge(carets), snappedAt: 0 }
}

// Keeps an undo point per burst of typing: a pause of 700 ms starts a new one
function snap(state: State): State {
  const now = Date.now()
  if (now - state.snappedAt < 700) return { ...state, snappedAt: now }
  const undo = [...state.undo, { lines: state.lines, carets: state.carets }]

  return { ...state, undo: undo.slice(-UNDO_DEPTH), snappedAt: now }
}

function edit(state: State, make: (lines: readonly string[], caret: Caret, index: number) => Edit | undefined): State {
  const result = applyEdits(state.lines, state.carets, make)
  if (!result.isChanged) return withCarets(state, result.carets)

  return { ...snap(state), lines: result.lines, carets: result.carets, isDirty: true, redo: [] }
}

function history(state: State, isRedo: boolean): State {
  const from = isRedo ? state.redo : state.undo
  const last = from[from.length - 1]
  if (!last) return state
  const current = { lines: state.lines, carets: state.carets }

  return {
    ...state,
    lines: last.lines,
    carets: last.carets,
    undo: isRedo ? [...state.undo, current] : state.undo.slice(0, -1),
    redo: isRedo ? state.redo.slice(0, -1) : [...state.redo, current],
    isDirty: true,
    snappedAt: 0,
  }
}

function selectedText(state: State): string | undefined {
  const parts = state.carets
    .map(rangeOf)
    .filter((range): range is Range => range !== undefined)
    .sort((a, b) => compare(a.from, b.from))
    .map(range => textIn(state.lines, range))

  return parts.length > 0 ? parts.join('\n') : undefined
}

// A paste with as many lines as carets puts one line at each caret
function paste(state: State, text: string): State {
  const parts = split(text)
  const order = state.carets.map((_, i) => i).sort((a, b) => compare(state.carets[a]!, state.carets[b]!))
  const isSpread = state.carets.length > 1 && parts.length === state.carets.length

  return edit(state, (lines, caret, index) => typeText(isSpread ? (parts[order.indexOf(index)] ?? '') : text)(lines, caret))
}

// Option+D: select the word at the caret, then add the next match of the selection
function addNextMatch(state: State): State {
  const first = primary(state)
  const range = rangeOf(first)
  if (!range) {
    const line = state.lines[first.row] ?? ''
    const [start, end] = wordAt(line, first.col)
    if (start === end) return state

    return withCarets(state, [{ row: first.row, col: end, anchor: { row: first.row, col: start } }, ...state.carets.slice(1)])
  }
  const matches = findAll(state.lines, textIn(state.lines, range))
  const taken = new Set(state.carets.map(caret => `${caret.row}:${caret.col}`))
  const after = nextMatch(matches.filter(match => !taken.has(`${match.to.row}:${match.to.col}`)), range.to, false)
  if (!after) return state

  return withCarets(state, [{ ...after.to, anchor: after.from }, ...state.carets])
}

function findMatches(state: State): Range[] {
  return state.find.isOpen ? findAll(state.lines, state.find.query) : []
}

function goToMatch(state: State, isBack: boolean): State {
  const matches = findMatches(state)
  const range = rangeOf(primary(state))
  const from = isBack ? (range?.from ?? primary(state)) : (range?.to ?? primary(state))
  const match = nextMatch(matches, from, isBack)
  if (!match) return state

  return withCarets(state, [{ ...match.to, anchor: match.from }])
}

function replaceOne(state: State): State {
  const range = rangeOf(primary(state))
  const isOnMatch = range !== undefined &&
    textIn(state.lines, range).toLowerCase() === state.find.query.toLowerCase()
  if (!isOnMatch) return goToMatch(state, false)
  const replaced = edit(withCarets(state, [primary(state)]), typeText(state.find.replace))

  return goToMatch(replaced, false)
}

function replaceAll(state: State): State {
  const matches = findMatches(state)
  if (matches.length === 0) return state
  const carets = matches.map(match => ({ ...match.to, anchor: match.from }))
  const replaced = edit({ ...state, carets }, typeText(state.find.replace))

  return withCarets(replaced, [primary(replaced)])
}

function openFind(state: State): State {
  const range = rangeOf(primary(state))
  const picked = range && range.from.row === range.to.row ? textIn(state.lines, range) : undefined

  return {
    ...state,
    find: { ...state.find, isOpen: true, hasKeys: true, field: 'query', query: picked ?? state.find.query },
  }
}

// Keys while the find bar holds them: they edit its fields; Enter steps through
// the matches, or replaces in the replace field; Option+Enter replaces all
function findKey(state: State, k: ClientKeyEvent): State {
  const find = state.find
  const field = find.field
  const value = find[field]
  const set = (text: string) => ({ ...state, find: { ...find, [field]: text } })
  if (k.ctrl && k.key === 'f') return { ...state, find: CLOSED_FIND }
  if (k.key === 'tab') return { ...state, find: { ...find, field: field === 'query' ? 'replace' : 'query' } }
  if (k.key === 'return' || k.key === 'enter') {
    if (k.meta) return replaceAll(state)
    if (field === 'replace') return replaceOne(state)

    return goToMatch(state, k.shift === true)
  }
  if (k.key === 'backspace') return set(value.slice(0, -1))
  if (k.meta && k.key === 'backspace') return set('')
  if (k.key === 'space') return set(value + ' ')
  if (k.ctrl || k.meta || NAMED.has(k.key)) return state
  const next = set(value + k.key)

  // Typing in the query searches again from the start of the current match
  const from = rangeOf(primary(next))?.from ?? primary(next)

  return field === 'query' ? goToMatch({ ...next, carets: [{ row: from.row, col: from.col }] }, false) : next
}

function motionOf(k: ClientKeyEvent): Motion | undefined {
  // Ghostty and Terminal.app turn Cmd+arrows into these readline keys, so they
  // behave as in a macOS text field
  if (k.ctrl) {
    const ctrl: Record<string, Motion> = { a: 'home', e: 'end', left: 'wordLeft', right: 'wordRight', home: 'docStart', end: 'docEnd' }
    return ctrl[k.key]
  }
  if (k.meta) {
    const meta: Record<string, Motion> = { left: 'wordLeft', right: 'wordRight', b: 'wordLeft', f: 'wordRight', up: 'docStart', down: 'docEnd' }
    return meta[k.key]
  }
  const plain: Record<string, Motion> = {
    up: 'up', down: 'down', left: 'left', right: 'right', home: 'home', end: 'end', pageup: 'pageUp', pagedown: 'pageDown',
  }

  return plain[k.key]
}

function handle(state: State, k: ClientKeyEvent, page: number): Outcome {
  const unit = indentUnit(state.doc.path)
  const isSave = (k.ctrl || k.meta) && k.key === 's'
  if (isSave) return { state, isSave: true }
  if (state.find.isOpen && state.find.hasKeys) return { state: findKey(state, k) }

  if (k.ctrl && k.key === 'f') return { state: openFind(state) }
  // Ctrl+Z suspends Claude Code before it reaches a Client, so undo is Option+Z
  const isRedo = (k.ctrl && k.key === 'y') || (k.meta && (k.key === 'Z' || (k.key === 'z' && k.shift === true)))
  if (isRedo) return { state: history(state, true) }
  if (k.meta && k.key === 'z') return { state: history(state, false) }
  // Ctrl+D ends Claude Code before it reaches a Client, so this is Option+D
  if (k.meta && k.key === 'd') return { state: addNextMatch(state) }
  if (k.meta && k.key === 'c') return { state, copy: selectedText(state) }
  if (k.meta && k.key === 'x') {
    const copy = selectedText(state)
    return copy === undefined ? { state } : { state: edit(state, typeText('')), copy }
  }
  if (k.meta && k.key === 'a') {
    const end = clamp(state.lines, { row: Infinity, col: Infinity })
    return { state: withCarets(state, [{ ...end, anchor: { row: 0, col: 0 } }]) }
  }

  const motion = motionOf(k)
  if (motion) {
    const isExtending = k.shift === true
    return { state: withCarets(state, state.carets.map(caret => move(state.lines, caret, motion, page, isExtending))) }
  }

  if (k.ctrl) {
    if (k.key === 'k') return { state: edit(state, killToEnd) }
    if (k.key === 'u') return { state: edit(state, killToStart) }
    if (k.key === 'w' || k.key === 'backspace') return { state: edit(state, deleteWordBack) }

    return { state }
  }
  if (k.meta && k.key === 'backspace') return { state: edit(state, deleteWordBack) }

  switch (k.key) {
    case 'return':
    case 'enter': return { state: edit(state, newline) }
    case 'backspace': return { state: edit(state, backspace) }
    case 'delete': return { state: edit(state, deleteForward) }
    case 'tab': return { state: edit(state, k.shift ? dedent(unit) : typeText(unit)) }
    case 'space': return { state: edit(state, typeText(' ')) }
  }
  if (NAMED.has(k.key) || k.meta) return { state }

  return { state: edit(state, typeText(k.key)) }
}

function save(state: State): State {
  return { ...state, wantSave: true }
}

// Queues the ops that bring the hooks' text up to the editor's
function queue(state: State): State {
  if (state.lines === state.sent || state.loading) return state

  return { ...state, outbox: [...state.outbox, ...diffOps(state.sent, state.lines)], sent: state.lines }
}

// Sends the next request when none is out: a chunk while loading, else ops
function pump(s: Surface, state: State): State {
  if (state.pending) return state
  const seq = state.seq + 1
  let request: EditorRequest
  let next = state
  let isSave = false
  if (state.loading) {
    request = { type: 'chunk', seq, rev: state.loading.rev, index: state.loading.index }
  } else if (state.outbox.length > 0 || state.wantSave) {
    const ops = batch(state.outbox)
    const rest = state.outbox.slice(ops.length)
    isSave = state.wantSave && rest.length === 0
    request = {
      type: 'sync',
      seq,
      base: state.base,
      ops,
      // The hooks write only a text whose pieces all came
      ...(rest.length > 0 ? { more: true as const } : {}),
      ...(isSave ? { save: hashText(state.sent.join('\n')) } : {}),
      isActive: true,
    }
    next = {
      ...state,
      outbox: rest,
      wantSave: isSave ? false : state.wantSave,
      ...(isSave ? { savingLines: state.lines } : {}),
    }
  } else {
    return state
  }
  s.post(request)

  return { ...next, seq, pending: { request, sentAt: Date.now(), isSave, path: state.doc.path } }
}

function sync(s: Surface, state: State): State {
  return pump(s, queue(state))
}

// Takes the hooks' answer to the request that is out
function answered(state: State, props: EditorProps): State {
  const pending = state.pending
  const reply = props.reply
  if (!pending || !reply || reply.seq !== pending.request.seq) return state
  const request = pending.request
  const base = { ...state, pending: undefined }
  // An answer about the file before a switch only frees the request slot
  if (pending.path !== state.doc.path) return base
  if (request.type === 'chunk') {
    const loading = state.loading
    if (!loading || loading.rev !== request.rev || reply.chunk === undefined) return base
    const parts = [...loading.parts, reply.chunk]
    const count = reply.count ?? loading.count
    if (parts.length < count) return { ...base, loading: { ...loading, count, parts, index: loading.index + 1 } }
    const lines = split(parts.join(''))
    const isDirty = reply.isDirty === true

    return { ...base, ...reload(base, lines), sent: lines, outbox: [], base: loading.rev, loading: undefined, isDirty }
  }
  if (reply.isStale) {
    // The hooks' copy went its own way: send the whole text again
    return { ...base, outbox: fullTextOps(state.lines), sent: state.lines, base: props.rev, wantSave: state.wantSave || pending.isSave }
  }
  if (pending.isSave && state.lines === state.savingLines) return { ...base, isDirty: false }

  return base
}

function scrollBy(state: State, by: number): State {
  const last = Math.max(0, state.lines.length - 1)

  return { ...state, top: Math.max(0, Math.min(last, state.top + by * WHEEL_ROWS)) }
}

function fresh(doc: Doc, seq: number): State {
  const lines = ['']
  const isEmpty = doc.size === 0

  return {
    lines,
    carets: [{ row: 0, col: 0 }],
    top: 0,
    isDirty: false,
    undo: [],
    redo: [],
    snappedAt: 0,
    doc,
    wasFocused: false,
    wheelSeq: 0,
    pasteSeq: 0,
    find: CLOSED_FIND,
    base: doc.rev,
    sent: lines,
    outbox: [],
    wantSave: false,
    seq,
    ...(isEmpty ? {} : { loading: { rev: doc.rev, count: doc.chunks, parts: [], index: 0 } }),
  }
}

// New text from the hooks: the carets follow the text around them
function reload(state: State, lines: string[]): Pick<State, 'lines' | 'carets'> {
  return { lines, carets: merge(mapCarets(state.carets, diffOps(state.lines, lines), lines)) }
}

// A new version from the hooks: a save, a format, a change on disk or another file
function adopt(state: State, doc: Doc): State {
  if (doc.path !== state.doc.path) return { ...fresh(doc, state.seq), pending: state.pending }

  const next = { ...state, doc }
  const textHash = hashText(state.lines.join('\n'))
  if (doc.hash === textHash) {
    return { ...next, base: doc.rev, sent: state.lines, outbox: [], loading: undefined, isDirty: false }
  }
  // A save wrote exactly this text (Cmd+S or a flush), or nothing is unsaved:
  // take the new version, formatted or changed on disk
  if (doc.savedHash === textHash || !state.isDirty) {
    return { ...next, outbox: [], loading: { rev: doc.rev, count: doc.chunks, parts: [], index: 0 } }
  }

  // Edits made since win: the hooks get the whole text again
  return { ...next, outbox: fullTextOps(state.lines), sent: state.lines, base: doc.rev }
}

// Where a pointer cell lands in the text
function spotAt(state: State, x: number, y: number): Spot {
  const gutter = String(state.lines.length).length + 1
  const row = Math.max(0, Math.min(state.lines.length - 1, state.top + y))

  return { row, col: colAt(state.lines[row] ?? '', x - gutter) }
}

function clicked(state: State, spot: Spot, isAdding: boolean, isExtending: boolean): State {
  const now = Date.now()
  const last = state.click
  const isRepeat = last !== undefined && now - last.at < CLICK_MS && last.row === spot.row && Math.abs(last.col - spot.col) <= 1
  const count = isRepeat ? last.count + 1 : 1
  const base = { ...state, click: { at: now, row: spot.row, col: spot.col, count }, find: { ...state.find, hasKeys: false } }
  const line = state.lines[spot.row] ?? ''
  if (count === 2) {
    const [start, end] = wordAt(line, spot.col)
    return withCarets(base, [{ row: spot.row, col: end, anchor: { row: spot.row, col: start } }])
  }
  if (count >= 3) {
    const isLast = spot.row >= state.lines.length - 1
    const end = isLast ? { row: spot.row, col: line.length } : { row: spot.row + 1, col: 0 }
    return withCarets(base, [{ ...end, anchor: { row: spot.row, col: 0 } }])
  }
  if (isAdding) return withCarets(base, [spot, ...state.carets])
  if (isExtending) {
    const first = primary(state)
    return withCarets(base, [{ ...spot, anchor: first.anchor ?? { row: first.row, col: first.col } }])
  }

  return withCarets(base, [{ ...spot, anchor: spot }])
}

function start(s: Surface, doc: Doc): State {
  s.onKey(k => {
    const current = s.state
    if (!current || current.loading) return
    const rows = editRows(s, current)
    const out = handle(current, k, rows - 1)
    // A copy goes out alone; the ops wait for the next key or redraw
    if (out.copy !== undefined) {
      s.post({ type: 'copy', text: out.copy, isActive: true })
      s.setState(follow(out.state, editRows(s, out.state)))
      return
    }
    const next = out.isSave ? save(out.state) : out.state
    s.setState(follow(sync(s, next), editRows(s, next)))
  })
  // A post can be lost when another one replaces it in the same frame
  s.every(250, () => {
    const current = s.state
    const pending = current?.pending
    if (!current || !pending || Date.now() - pending.sentAt < RESEND_MS) return
    s.post(pending.request)
    s.setState({ ...current, pending: { ...pending, sentAt: Date.now() } })
  })

  s.onPointer(e => {
    const current = s.state
    if (!current) return
    // No blur reaches a Client, so the pointer leaving the editor saves; the
    // editor stays the paste target until the person types into the prompt
    if (e.type === 'leave') {
      if (current.isDirty) s.setState(sync(s, save(current)))
      return
    }
    if (e.type === 'up') {
      const copy = selectedText(current)
      s.post(copy !== undefined ? { type: 'copy', text: copy, isActive: true } : { type: 'active', isActive: true })
      return
    }
    if (e.button !== 'left' || (e.type !== 'down' && e.type !== 'move')) return

    const rows = editRows(s, current)
    const spot = spotAt(current, e.x, e.y)
    if (e.type === 'down') {
      s.post({ type: 'active', isActive: true })
      s.setState(follow(clicked(current, spot, e.alt === true, e.shift === true), rows))
      return
    }
    const first = primary(current)
    const dragged = { ...spot, anchor: first.anchor ?? { row: first.row, col: first.col } }
    s.setState(follow(withCarets(current, [dragged, ...current.carets.slice(1)]), rows))
  })

  return fresh(doc, Date.now())
}

const Editor: ClientModule<EditorProps, State> = (props, s) => {
  const { Box, Text, Code } = s.elements
  const { isFocused, wheel, paste: pasted, reply: _reply, ...doc } = props
  let state = s.state ?? start(s, doc)
  state = answered(state, props)
  // Props arrive as new objects on every redraw, so compare what they say
  const isNewDoc = JSON.stringify(doc) !== JSON.stringify(state.doc)
  if (doc.rev > state.doc.rev) state = follow(adopt(state, doc), editRows(s, state))
  else if (isNewDoc && doc.rev === state.doc.rev) state = { ...state, doc }
  if (wheel && wheel.seq > state.wheelSeq) state = { ...scrollBy(state, wheel.by), wheelSeq: wheel.seq }
  if (pasted && pasted.seq > state.pasteSeq && !state.loading) {
    state = { ...follow(paste(state, pasted.text), editRows(s, state)), pasteSeq: pasted.seq }
  }
  if (isFocused !== undefined && isFocused !== state.wasFocused) {
    const isLeaving = state.wasFocused && !isFocused
    state = { ...(isLeaving && state.isDirty ? save(state) : state), wasFocused: isFocused }
  }
  state = sync(s, state)
  if (state !== s.state) s.setState(state)

  const rows = editRows(s, state)
  const top = Math.min(state.top, Math.max(0, state.lines.length - 1))
  const end = Math.min(state.lines.length, top + rows)
  const width = String(state.lines.length).length
  const errorLines = new Set(state.doc.diagnostics.map(d => d.line))
  const room = Math.max(4, (s.columns || 60) - width - 2)
  const first = primary(state)
  const caretRows = new Set(state.carets.map(caret => caret.row))

  const gutter = []
  for (let i = top; i < end; i++) {
    const n = String(i + 1).padStart(width)
    const isError = errorLines.has(i + 1)
    gutter.push(
      <Text color={isError ? 'error' : undefined} dimColor={!isError} bold={caretRows.has(i)}>
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

  const caretLine = state.lines[first.row] ?? ''
  const caretAt = cells(caretLine.slice(0, first.col))
  // A caret past the right edge needs its line shifted, so that line alone is plain text
  const isShifted = caretAt >= room - 1 && first.row >= top && first.row < end

  // Lines stay one highlighted Code run; matches, selections and carets are
  // drawn over it, so every line keeps its colours
  const parts = []
  if (isShifted) {
    const shown = show(caretLine)
    const at = show(caretLine.slice(0, first.col)).length
    const shift = Math.max(0, at - room + 2)
    if (first.row > top) parts.push(block(top, first.row))
    parts.push(
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {shown.slice(shift, at)}
          <Text inverse>{shown[at] ?? ' '}</Text>
          {shown.slice(at + 1)}
        </Text>
      </Box>,
    )
    if (first.row + 1 < end) parts.push(block(first.row + 1, end))
  } else if (end > top) {
    parts.push(block(top, end))
  }

  const overlay = (row: number, left: number, text: string, isMatch = false) => (
    <Box position="absolute" top={row - top} left={left} height={1}>
      {isMatch
        ? <Text backgroundColor={MATCH_BACKGROUND} wrap="truncate-end">{text}</Text>
        : <Text inverse wrap="truncate-end">{text}</Text>}
    </Box>
  )
  const paint = (range: Range, isMatch: boolean) => {
    for (let i = Math.max(top, range.from.row); i <= Math.min(end - 1, range.to.row); i++) {
      if (isShifted && i === first.row) continue
      const line = state.lines[i] ?? ''
      const from = i === range.from.row ? range.from.col : 0
      const to = i === range.to.row ? range.to.col : line.length
      const text = show(line.slice(from, to)) + (i === range.to.row ? '' : ' ')
      const left = cells(line.slice(0, from))
      if (text !== '' && left < room) parts.push(overlay(i, left, text, isMatch))
    }
  }
  const matches = findMatches(state)
  for (const match of matches) if (match.to.row >= top && match.from.row < end) paint(match, true)
  for (const caret of state.carets) {
    const range = rangeOf(caret)
    if (range) {
      paint(range, false)
      continue
    }
    const isVisible = caret.row >= top && caret.row < end && !(isShifted && caret.row === first.row)
    const line = state.lines[caret.row] ?? ''
    const left = cells(line.slice(0, caret.col))
    const under = line[caret.col]
    if (isVisible && left < room) parts.push(overlay(caret.row, left, under === undefined ? ' ' : show(under)))
  }

  const near = state.doc.diagnostics.find(d => d.line === first.row + 1)
  const listed = [
    ...(near ? [near] : []),
    ...state.doc.diagnostics.filter(d => d !== near),
  ].slice(0, 3)

  const mark = state.loading
    ? `loading ${state.loading.index + 1} of ${state.loading.count}`
    : state.pending?.isSave ? 'saving' : state.isDirty ? 'unsaved' : state.doc.status
  const count = state.doc.diagnostics.length
  const name = state.doc.path.slice(state.doc.path.lastIndexOf('/') + 1)
  const carets = state.carets.length > 1 ? `  ${state.carets.length} carets` : ''

  const find = state.find
  const matchIndex = matches.findIndex(match => {
    const range = rangeOf(first)
    return range !== undefined && compare(range.from, match.from) === 0 && compare(range.to, match.to) === 0
  })
  const field = (label: string, value: string, isActive: boolean) => (
    <Text>
      <Text dimColor>{label} </Text>
      <Text bold={isActive}>{value}</Text>
      {isActive && <Text inverse> </Text>}
    </Text>
  )

  return (
    <Box flexDirection="column" height={s.rows || undefined} backgroundColor={BACKGROUND}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={width + 1}>{gutter}</Box>
        <Box flexDirection="column" flexGrow={1} position="relative">
          {parts}
        </Box>
      </Box>
      {find.isOpen && (
        <Box flexDirection="row" gap={2} height={1}>
          {field('Find', find.query, find.hasKeys && find.field === 'query')}
          {field('Replace', find.replace, find.hasKeys && find.field === 'replace')}
          <Text dimColor>
            {matches.length === 0 ? 'no results' : `${matchIndex >= 0 ? matchIndex + 1 : '?'} of ${matches.length}`}
          </Text>
        </Box>
      )}
      {listed.map(d => (
        <Text color="error" wrap="truncate-end">
          {d.line}:{d.col} {d.code} {d.message}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {name}  {first.row + 1}:{first.col + 1}{carets}  {mark}  {count === 0 ? 'no problems' : `${count} problems`}
      </Text>
    </Box>
  )
}

export default Editor
