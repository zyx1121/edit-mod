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
}

// A change to the text: replace `from`..`to` with `text`, or start from nothing
export type Op = { from: Spot; to: Spot; text: string } | { reset: true }

export type Wheel = { seq: number; by: number }

export type Paste = { seq: number; text: string }

// The answer to the editor's request `seq`
export type Reply = { seq: number; chunk?: string; isStale?: true }

export type EditorProps = Doc & { isFocused?: boolean; wheel?: Wheel; paste?: Paste; reply?: Reply }

// What the editor asks of the hooks; each request waits for its reply
export type EditorRequest =
  | { type: 'sync'; seq: number; base: number; ops: Op[]; save?: string; isActive: true }
  | { type: 'chunk'; seq: number; rev: number; index: number }

declare module 'claude-code' {
  interface PluginState {
    'edit-mod': { doc: Doc | null; wheel: Wheel; paste: Paste }
  }
}
