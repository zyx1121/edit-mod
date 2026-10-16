import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { CompletionItem, Diagnostic, Doc, EditorProps, EditorRequest, Op } from '../types'
import {
  applyEdits, applyTextEdits, backspace, clamp, compare, dedent, diagnosticRange, deleteForward, deleteWordBack, findAll, killToEnd,
  killToStart, merge, move, newline, nextMatch, rangeOf, textIn, typeText,
} from './editor/model'
import type { Caret, Edit, Motion, Range, Spot } from './editor/model'
import { batch, diffOps, fullTextOps, mapCarets } from './editor/sync'
import { cells, colAt, indentUnit, isWordChar, show, split, wordAt } from './editor/text'
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

// A language server request waiting to go out; the latest one wins
type Ask =
  | { type: 'complete' | 'hover' | 'definition'; row: number; col: number }
  | { type: 'rename'; row: number; col: number; name: string }

type Completion = { row: number; col: number; items: CompletionItem[]; index: number }

type Hover = { row: number; col: number; text: string }

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
  ask?: Ask
  completion?: Completion
  hover?: Hover
  rename?: { row: number; col: number; name: string }
  // The text a rename was asked on: input waits until its answer comes
  renaming?: string[]
  note?: string
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
const HOVER_MS = 600
const POPUP_BACKGROUND = '#1f2430'
const POPUP_ROWS = 8
// Function keys reach a Client as their raw escape sequences
const F2 = new Set(['\u001bOQ', '\u001b[12~'])
const F12 = new Set(['\u001b[24~'])
const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert',
])
const CLOSED_FIND: Find = { isOpen: false, hasKeys: false, field: 'query', query: '', replace: '' }

// What a key adds to a text field: a terminal can fold several typed characters
// into one key, and a function key arrives as its escape sequence
function typedText(k: ClientKeyEvent): string {
  if (k.key === 'space') return ' '
  const isText = !k.ctrl && !k.meta && !NAMED.has(k.key) && !/[\u0000-\u001f\u007f]/.test(k.key)

  return isText ? k.key : ''
}

// The theme colour a diagnostic draws in, by how bad it is
function severityColor(d: Diagnostic): string {
  return d.severity === 'warning' ? 'warning' : d.severity === 'info' ? 'suggestion' : 'error'
}

const SEVERITY_RANK = { error: 3, warning: 2, info: 1 } as const

function primary(state: State): Caret {
  return state.carets[0] ?? { row: 0, col: 0 }
}

function editRows(s: Surface, state: { doc: Doc; find?: Find; rename?: unknown }): number {
  const shown = Math.min(3, state.doc.diagnostics.length) + (state.find?.isOpen ? 1 : 0) + (state.rename ? 1 : 0)

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
  if (k.meta && k.key === 'backspace') return set('')
  if (k.key === 'backspace') return set(value.slice(0, -1))
  const typed = typedText(k)
  if (typed === '') return state
  const next = set(value + typed)

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
  // A key the engine did not name (a function key, say) arrives as its escape sequence
  if (NAMED.has(k.key) || k.meta || /[\u0000-\u001f\u007f]/.test(k.key)) return { state }

  return { state: edit(state, typeText(k.key)) }
}

// Language server features

function wordStart(line: string, col: number): number {
  let start = col
  while (start > 0 && isWordChar(line[start - 1])) start--

  return start
}

function shownItems(state: State): CompletionItem[] {
  const completion = state.completion
  if (!completion) return []
  const caret = primary(state)
  const prefix = (state.lines[caret.row] ?? '').slice(completion.col, caret.col).toLowerCase()
  if (prefix === '') return completion.items

  return completion.items.filter(item => item.label.toLowerCase().startsWith(prefix))
}

function accept(state: State, item: CompletionItem): State {
  const completion = state.completion
  if (!completion) return state
  const caret = primary(state)
  const from = { row: completion.row, col: completion.col }
  const replaced = edit(withCarets(state, [{ row: caret.row, col: caret.col, anchor: from }]), typeText(item.insert))

  return { ...replaced, completion: undefined }
}

// Keys for the completion list, the rename bar and the function keys; undefined
// lets the editor handle the key as usual
function lspKey(state: State, k: ClientKeyEvent): Outcome | undefined {
  const caret = primary(state)
  if (state.rename) {
    const rename = state.rename
    if (F2.has(k.key)) return { state: { ...state, rename: undefined } }
    if (k.key === 'return' || k.key === 'enter') {
      if (rename.name === '') return { state: { ...state, rename: undefined } }
      const ask = { type: 'rename' as const, row: rename.row, col: rename.col, name: rename.name }
      return { state: { ...state, rename: undefined, ask, renaming: state.lines, note: 'renaming' } }
    }
    if (k.key === 'backspace') return { state: { ...state, rename: { ...rename, name: rename.name.slice(0, -1) } } }
    const typed = typedText(k)
    return { state: typed !== '' ? { ...state, rename: { ...rename, name: rename.name + typed } } : state }
  }
  if (F12.has(k.key)) return { state: { ...state, ask: { type: 'definition', row: caret.row, col: caret.col } } }
  if (F2.has(k.key)) {
    const line = state.lines[caret.row] ?? ''
    const [start, end] = wordAt(line, caret.col)
    if (start === end || !state.doc.hasLsp) return { state }
    return { state: { ...state, rename: { row: caret.row, col: start, name: line.slice(start, end) } } }
  }
  const items = shownItems(state)
  if (state.completion && items.length > 0) {
    const index = Math.min(state.completion.index, items.length - 1)
    if (k.key === 'down' || k.key === 'up') {
      const step = k.key === 'down' ? 1 : items.length - 1
      return { state: { ...state, completion: { ...state.completion, index: (index + step) % items.length } } }
    }
    if (k.key === 'tab' || k.key === 'return' || k.key === 'enter') return { state: accept(state, items[index]!) }
  }

  return undefined
}

// After a key: open, keep or close the completion list as VS Code does
function afterKey(before: State, state: State, k: ClientKeyEvent): State {
  const next = { ...state, note: undefined, hover: undefined }
  if (!next.doc.hasLsp || next.carets.length !== 1 || next.rename) return { ...next, completion: undefined }
  // A terminal can fold several typed characters into one key: the last one counts
  const typed = typedText(k).slice(-1)
  const caret = primary(next)
  const line = next.lines[caret.row] ?? ''
  const isTyping = next.lines !== before.lines
  const completion = next.completion
  if (completion) {
    const isKept = isTyping && caret.row === completion.row && caret.col >= completion.col &&
      (isWordChar(typed) || k.key === 'backspace')
    if (typed === '.') return { ...next, completion: undefined, ask: { type: 'complete', row: caret.row, col: caret.col } }

    return isKept ? next : { ...next, completion: undefined }
  }
  const isWordStart = isWordChar(typed) && caret.col > wordStart(line, caret.col)
  if (isTyping && (typed === '.' || isWordStart)) return { ...next, ask: { type: 'complete', row: caret.row, col: caret.col } }

  return next
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
  } else if (state.ask) {
    // Typing goes on while earlier requests are out: complete where the caret is now
    const caret = primary(state)
    const ask = state.ask.type === 'complete' ? { ...state.ask, row: caret.row, col: caret.col } : state.ask
    request = { ...ask, seq }
    next = { ...state, ask: undefined }
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
  if (pending.path !== state.doc.path) return { ...base, renaming: undefined }
  // A failed request leaves the text as it is and unsaved; a failed download stops
  if (reply.isFailed) return { ...base, note: reply.note, renaming: undefined, loading: undefined }
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
  if (request.type === 'sync') {
    if (pending.isSave && state.lines === state.savingLines) return { ...base, isDirty: false }
    return base
  }
  return lspAnswered(base, request, reply)
}

function lspAnswered(state: State, request: EditorRequest, reply: NonNullable<EditorProps['reply']>): State {
  const caret = primary(state)
  const noted = reply.note ? { ...state, note: reply.note } : state
  if (request.type === 'complete') {
    const found = reply.completion
    if (!found || found.items.length === 0 || caret.row !== found.row) return { ...noted, completion: undefined }
    const col = wordStart(state.lines[caret.row] ?? '', Math.min(found.col, caret.col))

    return { ...noted, completion: { row: found.row, col, items: found.items, index: 0 } }
  }
  if (request.type === 'hover') {
    return reply.hover && state.hover?.row === reply.hover.row ? { ...noted, hover: reply.hover } : noted
  }
  if (request.type === 'definition') {
    return reply.jump ? withCarets(noted, [clamp(state.lines, reply.jump)]) : noted
  }
  if (request.type === 'rename') {
    const done = { ...noted, renaming: undefined }
    if (!reply.edits || reply.edits.length === 0) return done
    // The text moved under the rename (a change on disk): its ranges no longer fit
    if (state.renaming !== state.lines) return { ...done, note: 'the text changed; rename again' }
    const lines = applyTextEdits(state.lines, reply.edits)
    return { ...snap(done), lines, carets: merge(state.carets.map(one => clamp(lines, one))), isDirty: true, redo: [] }
  }

  return noted
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
    if (!current || current.loading || current.renaming) return
    const rows = editRows(s, current)
    const viaLsp = lspKey(current, k)
    const out = viaLsp ?? handle(current, k, rows - 1)
    // A copy goes out alone; the ops wait for the next key or redraw
    if (out.copy !== undefined) {
      s.post({ type: 'copy', text: out.copy, isActive: true })
      s.setState(follow(out.state, editRows(s, out.state)))
      return
    }
    // The completion list, the rename bar and the function keys took the key themselves
    const next = viaLsp ? viaLsp.state : afterKey(current, out.isSave ? save(out.state) : out.state, k)
    s.setState(follow(sync(s, next), editRows(s, next)))
  })
  // Where the pointer rests: a rest of HOVER_MS asks the language server once
  let rest: { x: number; y: number; at: number; isAsked: boolean } | undefined
  // A post can be lost when another one replaces it in the same frame
  s.every(250, () => {
    const current = s.state
    if (!current) return
    const pending = current.pending
    if (pending && Date.now() - pending.sentAt >= RESEND_MS) {
      s.post(pending.request)
      s.setState({ ...current, pending: { ...pending, sentAt: Date.now() } })
      return
    }
    if (!rest || rest.isAsked || Date.now() - rest.at < HOVER_MS || current.loading) return
    rest.isAsked = true
    const spot = spotAt(current, rest.x, rest.y)
    const under = (current.lines[spot.row] ?? '')[spot.col]
    if (under === undefined || /\s/.test(under)) return
    const hover = { row: spot.row, col: spot.col, text: '' }
    const ask: Ask | undefined = current.doc.hasLsp ? { type: 'hover', row: spot.row, col: spot.col } : undefined
    s.setState(sync(s, { ...current, hover, ...(ask ? { ask } : {}) }))
  })

  s.onPointer(e => {
    const current = s.state
    if (!current) return
    // No blur reaches a Client, so the pointer leaving the editor saves; the
    // editor stays the paste target until the person types into the prompt
    if (e.type === 'leave') {
      rest = undefined
      const left = current.hover ? { ...current, hover: undefined } : current
      if (current.isDirty) s.setState(sync(s, save(left)))
      else if (left !== current) s.setState(left)
      return
    }
    if (e.type === 'move' && !e.button) {
      if (rest && rest.x === e.x && rest.y === e.y) return
      rest = { x: e.x, y: e.y, at: Date.now(), isAsked: false }
      if (current.hover) s.setState({ ...current, hover: undefined })
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
      if (current.renaming) return
      s.post({ type: 'active', isActive: true })
      const placed = { ...clicked(current, spot, e.alt === true, e.shift === true), completion: undefined, hover: undefined, rename: undefined }
      // Ctrl+click goes to the definition, as Cmd+click does in VS Code
      const next = e.ctrl && current.doc.hasLsp ? { ...placed, ask: { type: 'definition' as const, row: spot.row, col: spot.col } } : placed
      s.setState(follow(sync(s, next), rows))
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
  const caretBefore = primary(state)
  state = answered(state, props)
  if (compare(primary(state), caretBefore) !== 0) state = follow(state, editRows(s, state))
  // Props arrive as new objects on every redraw, so compare what they say
  const isNewDoc = JSON.stringify(doc) !== JSON.stringify(state.doc)
  if (doc.rev > state.doc.rev) state = follow(adopt(state, doc), editRows(s, state))
  else if (isNewDoc && doc.rev === state.doc.rev) state = { ...state, doc }
  if (wheel && wheel.seq > state.wheelSeq) state = { ...scrollBy(state, wheel.by), wheelSeq: wheel.seq }
  if (pasted && pasted.seq > state.pasteSeq && !state.loading && !state.renaming) {
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
  // The worst diagnostic on each line colours its number
  const worst = new Map<number, Diagnostic>()
  for (const d of state.doc.diagnostics) {
    const held = worst.get(d.line)
    if (!held || SEVERITY_RANK[d.severity ?? 'error'] > SEVERITY_RANK[held.severity ?? 'error']) worst.set(d.line, d)
  }
  const room = Math.max(4, (s.columns || 60) - width - 2)
  const first = primary(state)
  const caretRows = new Set(state.carets.map(caret => caret.row))

  const gutter = []
  for (let i = top; i < end; i++) {
    const n = String(i + 1).padStart(width)
    const marked = worst.get(i + 1)
    gutter.push(
      <Text color={marked ? severityColor(marked) : undefined} dimColor={!marked} bold={caretRows.has(i)}>
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

  // A terminal has no wavy underline, so a diagnostic is an underline in its colour
  type Paint = { kind: 'match' } | { kind: 'select' } | { kind: 'squiggle'; color: string }
  const overlay = (row: number, left: number, text: string, paint: Paint) => (
    <Box position="absolute" top={row - top} left={left} height={1}>
      {paint.kind === 'match'
        ? <Text backgroundColor={MATCH_BACKGROUND} wrap="truncate-end">{text}</Text>
        : paint.kind === 'squiggle'
        ? <Text color={paint.color} underline wrap="truncate-end">{text}</Text>
        : <Text inverse wrap="truncate-end">{text}</Text>}
    </Box>
  )
  const paint = (range: Range, how: Paint) => {
    for (let i = Math.max(top, range.from.row); i <= Math.min(end - 1, range.to.row); i++) {
      if (isShifted && i === first.row) continue
      const line = state.lines[i] ?? ''
      const from = i === range.from.row ? range.from.col : 0
      const to = i === range.to.row ? range.to.col : line.length
      const text = show(line.slice(from, to)) + (i === range.to.row ? '' : ' ')
      const left = cells(line.slice(0, from))
      if (text !== '' && left < room) parts.push(overlay(i, left, text, how))
    }
  }
  const matches = findMatches(state)
  for (const match of matches) if (match.to.row >= top && match.from.row < end) paint(match, { kind: 'match' })
  for (const d of state.doc.diagnostics) {
    if (d.line - 1 > end || (d.endLine ?? d.line) - 1 < top) continue
    paint(diagnosticRange(state.lines, d), { kind: 'squiggle', color: severityColor(d) })
  }
  for (const caret of state.carets) {
    const range = rangeOf(caret)
    if (range) {
      paint(range, { kind: 'select' })
      continue
    }
    const isVisible = caret.row >= top && caret.row < end && !(isShifted && caret.row === first.row)
    const line = state.lines[caret.row] ?? ''
    const left = cells(line.slice(0, caret.col))
    const under = line[caret.col]
    if (isVisible && left < room) parts.push(overlay(caret.row, left, under === undefined ? ' ' : show(under), { kind: 'select' }))
  }

  // The completion list sits under the caret, or above it near the bottom
  const items = shownItems(state)
  if (state.completion && items.length > 0 && first.row >= top && first.row < end) {
    const index = Math.min(state.completion.index, items.length - 1)
    const start = Math.max(0, Math.min(index - POPUP_ROWS + 1, items.length - POPUP_ROWS))
    const visible = items.slice(start, start + POPUP_ROWS)
    const widest = Math.max(...visible.map(item => cells(item.label) + (item.detail ? cells(item.detail) + 2 : 0)))
    const popupWidth = Math.max(10, Math.min(room, widest + 2, 60))
    const below = first.row - top + 1
    const popupTop = below + visible.length <= rows ? below : Math.max(0, first.row - top - visible.length)
    const left = Math.max(0, Math.min(cells((state.lines[first.row] ?? '').slice(0, state.completion.col)), room - popupWidth))
    parts.push(
      <Box position="absolute" top={popupTop} left={left} width={popupWidth} flexDirection="column" backgroundColor={POPUP_BACKGROUND}>
        {visible.map((item, i) => (
          <Text inverse={start + i === index} wrap="truncate-end">
            {' '}{item.label}{item.detail ? <Text dimColor>  {item.detail}</Text> : ''}{' '}
          </Text>
        ))}
      </Box>,
    )
  }

  // The hover box: diagnostics at that spot, then what the language server says
  const hover = state.hover
  if (hover && hover.row >= top && hover.row < end) {
    const at = { line: hover.row + 1, col: hover.col + 1 }
    const here = state.doc.diagnostics.filter(d => {
      const isAfterStart = at.line > d.line || (at.line === d.line && at.col >= d.col)
      const endLine = d.endLine ?? d.line
      const endCol = d.endCol ?? d.col + 1
      const isBeforeEnd = at.line < endLine || (at.line === endLine && at.col < Math.max(endCol, d.col + 1))
      return isAfterStart && isBeforeEnd
    })
    const textLines = hover.text === '' ? [] : hover.text.split('\n').filter(line => line.trim() !== '')
    const shown = [...here.map(d => ({ text: `${d.code ? d.code + ': ' : ''}${d.message.split('\n')[0]}`, color: d.severity === 'warning' ? 'warning' : d.severity === 'info' ? undefined : 'error' })),
      ...textLines.map(text => ({ text, color: undefined }))].slice(0, 10)
    if (shown.length > 0) {
      const boxWidth = Math.max(10, Math.min(room, Math.max(...shown.map(line => cells(line.text))) + 2))
      const above = hover.row - top - shown.length
      const boxTop = above >= 0 ? above : hover.row - top + 1
      const line = state.lines[hover.row] ?? ''
      const left = Math.max(0, Math.min(cells(line.slice(0, hover.col)), room - boxWidth))
      parts.push(
        <Box position="absolute" top={boxTop} left={left} width={boxWidth} flexDirection="column" backgroundColor={POPUP_BACKGROUND}>
          {shown.map(one => <Text color={one.color} wrap="truncate-end"> {one.text}</Text>)}
        </Box>,
      )
    }
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
      {state.rename && (
        <Box flexDirection="row" gap={2} height={1}>
          {field('Rename', state.rename.name, true)}
        </Box>
      )}
      {listed.map(d => (
        <Text color={d.severity === 'warning' ? 'warning' : d.severity === 'info' ? undefined : 'error'} dimColor={d.severity === 'info'} wrap="truncate-end">
          {d.line}:{d.col} {d.code} {d.message.split('\n')[0]}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {name}  {first.row + 1}:{first.col + 1}{carets}  {state.note ?? mark}  {count === 0 ? 'no problems' : `${count} problems`}
      </Text>
    </Box>
  )
}

export default Editor
