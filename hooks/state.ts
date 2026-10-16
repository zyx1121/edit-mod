// What the language server last said about each file, and how it reaches the
// document. `doc` is the same address that hooks/register.tsx declares.

import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Diagnostic } from '../types'

const doc = atom({ plugin: 'edit-mod', key: 'doc' } as const, null)

export const lspDiagnostics = new Map<string, Diagnostic[]>()

export function byPlace(a: Diagnostic, b: Diagnostic): number {
  return a.line - b.line || a.col - b.col
}

// A language server's diagnostics replace the lint ones; a format error stays
export async function onDiagnostics($: EngineInterface, path: string, found: Diagnostic[]): Promise<void> {
  const sorted = [...found].sort(byPlace).slice(0, 200)
  lspDiagnostics.set(path, sorted)
  await update($, doc, last => {
    if (!last || last.path !== path) return last
    const kept = last.diagnostics.filter(d => d.code === 'format')

    return { ...last, diagnostics: [...kept, ...sorted].sort(byPlace).slice(0, 200) }
  })
}
