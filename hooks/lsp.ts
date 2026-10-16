// The hooks' side of the LSP bridge (bridge/lsp.ts): starts it once a file with
// a language server opens, forwards the editor's changes to it in order, and
// hands its diagnostics to `onDiagnostics`.

import type { EngineInterface } from 'claude-code'

import type { CompletionItem, Diagnostic, Op, Spot, TextEdit } from '../types'
import { onDiagnostics } from './state'

type Bridge = { socket: string; ready: Promise<boolean> }

type LspPosition = { line: number; character: number }

type LspDiagnostic = {
  range: { start: LspPosition; end: LspPosition }
  severity?: number
  code?: string | number
  source?: string
  message: string
}

const LSP_EXTS = new Set(['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'jsonc', 'md', 'py'])

let bridge: Bridge | undefined
// Changes go to the bridge one after another, and a request waits for them
let queue: Promise<unknown> = Promise.resolve()
const opened = new Set<string>()

export function isLspOpen(path: string): boolean {
  return bridge !== undefined && opened.has(path)
}

export function hasLsp(path: string): boolean {
  return LSP_EXTS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
}

export function toDiagnostic(d: LspDiagnostic): Diagnostic {
  const severity = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info'

  return {
    line: d.range.start.line + 1,
    col: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endCol: d.range.end.character + 1,
    severity,
    code: String(d.code ?? d.source ?? ''),
    message: plain(d.message),
  }
}

async function call($: EngineInterface, socket: string, route: string, body: unknown): Promise<{ ok?: boolean; result?: unknown }> {
  const response = await $.http.fetch(`http://lsp${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socket,
  })

  return JSON.parse(response.text) as { ok?: boolean; result?: unknown }
}

function chain(work: () => Promise<unknown>): void {
  queue = queue.then(work).catch(() => undefined)
}

async function run($: EngineInterface, socket: string, done: (isReady: boolean) => void): Promise<void> {
  const root = await $.session.root()
  let buffer = ''
  try {
    const stream = $.process.spawn({ argv: ['bun', `${$.plugin.root}/bridge/lsp.ts`, socket, root] })
    for await (const piece of stream) {
      if (piece.stream !== 'stdout') continue
      buffer += piece.text
      let end = buffer.indexOf('\n')
      while (end >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        end = buffer.indexOf('\n')
        let message: { type?: string; path?: string; diagnostics?: LspDiagnostic[] }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'ready') done(true)
        if (message.type === 'diagnostics' && message.path) {
          const found = (message.diagnostics ?? []).map(toDiagnostic)
          await onDiagnostics($, message.path, found).catch(() => undefined)
        }
      }
    }
  } catch {
    // The bridge could not start or ended; the editor goes on without it
  } finally {
    done(false)
    bridge = undefined
    opened.clear()
  }
}

async function ensure($: EngineInterface): Promise<string | undefined> {
  if (!bridge) {
    const folder = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    const socket = `${folder}/edit-mod-${crypto.randomUUID().slice(0, 8)}.sock`
    let done: (isReady: boolean) => void = () => undefined
    const ready = new Promise<boolean>(resolve => {
      let isSettled = false
      done = isReady => {
        if (isSettled) return
        isSettled = true
        resolve(isReady)
      }
    })
    bridge = { socket, ready }
    void run($, socket, done)
  }
  const current = bridge

  return (await current.ready) ? current.socket : undefined
}

export async function lspOpen($: EngineInterface, path: string, text: string): Promise<void> {
  if (!hasLsp(path)) return
  const socket = await ensure($)
  if (!socket) return
  opened.add(path)
  chain(() => call($, socket, '/open', { path, text }))
}

function toChange(op: Op): unknown {
  if ('reset' in op) return { text: '' }

  return {
    range: {
      start: { line: op.from.row, character: op.from.col },
      end: { line: op.to.row, character: op.to.col },
    },
    text: op.text,
  }
}

export function lspChange($: EngineInterface, path: string, ops: readonly Op[]): void {
  const socket = bridge?.socket
  if (!socket || !opened.has(path) || ops.length === 0) return
  chain(() => call($, socket, '/change', { path, changes: ops.map(toChange) }))
}

export function lspReplace($: EngineInterface, path: string, text: string): void {
  const socket = bridge?.socket
  if (!socket || !opened.has(path)) return
  chain(() => call($, socket, '/change', { path, changes: [{ text }] }))
}

export function lspSave($: EngineInterface, path: string): void {
  const socket = bridge?.socket
  if (!socket || !opened.has(path)) return
  chain(() => call($, socket, '/save', { path }))
}

export async function lspRequest($: EngineInterface, path: string, method: string, params: unknown): Promise<unknown> {
  const socket = bridge?.socket
  if (!socket || !opened.has(path)) return undefined
  await queue
  const answer = await call($, socket, '/request', { path, method, params }).catch(() => undefined)

  return answer?.ok ? answer.result : undefined
}

// Converters from LSP shapes to the editor's

export type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } }
type LspTextEdit = { range: LspRange; newText: string }

function fromLsp(range: LspRange): { from: Spot; to: Spot } {
  return {
    from: { row: range.start.line, col: range.start.character },
    to: { row: range.end.line, col: range.end.character },
  }
}

export function pathOf(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname)
}

// Snippet placeholders read as their text: `${1:name}` as `name`, `$0` as nothing
function unsnippet(text: string): string {
  return text.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '')
}

export function toItems(result: unknown): CompletionItem[] {
  const list = Array.isArray(result) ? result : ((result as { items?: unknown[] } | undefined)?.items ?? [])
  type LspItem = {
    label: string
    detail?: string
    insertText?: string
    sortText?: string
    textEdit?: LspTextEdit | { insert: LspRange; newText: string }
  }
  const items = (list as LspItem[]).slice().sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label))

  return items.slice(0, 200).map(item => {
    const edit = item.textEdit
    const range = edit ? ('range' in edit ? edit.range : edit.insert) : undefined
    const insert = unsnippet(edit?.newText ?? item.insertText ?? item.label)

    return {
      label: item.label,
      insert,
      ...(item.detail ? { detail: item.detail.split('\n')[0]! } : {}),
      ...(range ? fromLsp(range) : {}),
    }
  })
}

export function hoverText(result: unknown): string {
  const contents = (result as { contents?: unknown } | undefined)?.contents
  const parts = Array.isArray(contents) ? contents : [contents]
  const text = parts
    .map(part => (typeof part === 'string' ? part : ((part as { value?: string } | undefined)?.value ?? '')))
    .join('\n')

  return text
    .split('\n')
    .filter(line => !line.startsWith('```'))
    .join('\n')
    .trim()
    .slice(0, 1500)
}

export function editsByPath(result: unknown): Map<string, TextEdit[]> {
  type WorkspaceEdit = {
    changes?: Record<string, LspTextEdit[]>
    documentChanges?: { textDocument?: { uri: string }; edits?: LspTextEdit[] }[]
  }
  const edit = (result ?? {}) as WorkspaceEdit
  const found = new Map<string, TextEdit[]>()
  const add = (uri: string, edits: LspTextEdit[]) => {
    const path = pathOf(uri)
    found.set(path, [...(found.get(path) ?? []), ...edits.map(one => ({ ...fromLsp(one.range), text: one.newText }))])
  }
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits)
  for (const change of edit.documentChanges ?? []) if (change.textDocument && change.edits) add(change.textDocument.uri, change.edits)

  return found
}
