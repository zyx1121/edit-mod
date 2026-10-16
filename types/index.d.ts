export type Spot = { row: number; col: number }

export type Diagnostic = {
  line: number
  col: number
  endLine?: number
  endCol?: number
  severity?: 'error' | 'warning' | 'info'
  code: string
  message: string
}

// The document as the hooks last wrote or read it: `rev` names that version,
// `hash` its text, and the editor downloads it in `chunks` pieces
export type Doc = {
  path: string
  rev: number
  size: number
  hash: string
  chunks: number
  savedHash?: string
  diagnostics: Diagnostic[]
  status: string
  // A language server takes this file: completion, hover, definition and rename
  hasLsp?: boolean
  // Where the caret starts, for a jump to a definition in another file
  caret?: Spot
}

export type CompletionItem = { label: string; insert: string; detail?: string; from?: Spot; to?: Spot }

export type TextEdit = { from: Spot; to: Spot; text: string }

// A change to the text: replace `from`..`to` with `text`, or start from nothing
export type Op = { from: Spot; to: Spot; text: string } | { reset: true }

export type Wheel = { seq: number; by: number }

export type Paste = { seq: number; text: string }

// The answer to the editor's request `seq`. A chunk names how many pieces the
// text has, and `isDirty` when the hooks served unsaved text
export type Reply = {
  seq: number
  chunk?: string
  count?: number
  isDirty?: true
  isStale?: true
  // The request failed in the hooks; `note` says why
  isFailed?: true
  completion?: { row: number; col: number; items: CompletionItem[] }
  hover?: { row: number; col: number; text: string }
  jump?: Spot
  edits?: TextEdit[]
  note?: string
}

export type EditorProps = Doc & { isFocused?: boolean; wheel?: Wheel; paste?: Paste; reply?: Reply }

// What the editor asks of the hooks; each request waits for its reply
export type EditorRequest =
  | { type: 'sync'; seq: number; base: number; ops: Op[]; more?: true; save?: string; isActive: true }
  | { type: 'chunk'; seq: number; rev: number; index: number }
  | { type: 'complete' | 'hover' | 'definition'; seq: number; row: number; col: number }
  | { type: 'rename'; seq: number; row: number; col: number; name: string }

declare module 'claude-code' {
  interface PluginState {
    'edit-mod': { doc: Doc | null; wheel: Wheel; paste: Paste }
  }
}
