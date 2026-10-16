export type Diagnostic = { line: number; col: number; code: string; message: string }

export type Doc = {
  path: string
  text: string
  rev: number
  savedHash?: string
  diagnostics: Diagnostic[]
  status: string
}

export type Wheel = { seq: number; by: number }

export type Paste = { seq: number; text: string }

export type EditorProps = Doc & { isFocused?: boolean; wheel?: Wheel; paste?: Paste }

declare module 'claude-code' {
  interface PluginState {
    'edit-mod': { doc: Doc | null; wheel: Wheel; paste: Paste }
  }
}
