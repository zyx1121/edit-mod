import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Diagnostic, Doc, EditorProps, EditorRequest, Reply } from '../types'
import { applyOps, PIECE } from './editor/sync'
import { split } from './editor/text'
import { hashText } from './hash'

const PANE = 'editor'
const doc = atom({ plugin: 'edit-mod', key: 'doc' } as const, null)
const wheel = atom({ plugin: 'edit-mod', key: 'wheel' } as const, { seq: 0, by: 0 })

const paste = atom({ plugin: 'edit-mod', key: 'paste' } as const, { seq: 0, text: '' })

// The hooks' copy of the editor's text, kept current by the editor's ops. It is
// what a save writes, also when the pane closes or the session ends.
type Mirror = { path: string; rev: number; lines: string[] }
let mirror: Mirror | undefined
let isMirrorDirty = false
// The text of the current `rev` as the hooks read or wrote it, for downloads
let content: { rev: number; text: string } | undefined
// The last sync request applied: a resent one is answered, not applied again
let lastSeq = 0
let lastFocused: boolean | undefined
// Whether the person is working in the editor: clicked or typed into it and has
// not typed into the prompt since. A paste then belongs to the editor.
let isEditorActive = false

const DENO_FMT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs', 'json', 'jsonc', 'md',
  'css', 'scss', 'sass', 'less', 'html', 'yml', 'yaml', 'svelte', 'vue', 'astro',
])
const NO_COLOR = { NO_COLOR: '1' }
const DENO_LINT = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'])

type Tooled = { text: string; diagnostics: Diagnostic[] }
type EditorMessage = EditorRequest | { type: 'copy' | 'active'; text?: string; isActive?: boolean }

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

function firstLine(text: string): string {
  return plain(text).trim().split('\n')[0] ?? ''
}

async function absolute($: EngineInterface, path: string): Promise<string> {
  const home = $.env.get('HOME') ?? ''
  const expanded = path.startsWith('~/') ? home + path.slice(1) : path
  if (expanded.startsWith('/')) return expanded
  const root = await $.session.root()
  return `${root.replace(/\/$/, '')}/${expanded}`
}

async function format($: EngineInterface, path: string, text: string): Promise<Tooled> {
  const ext = extOf(path)
  let argv: string[] | undefined
  if (DENO_FMT.has(ext)) argv = ['deno', 'fmt', '--ext', ext, '-']
  else if (ext === 'py') argv = ['uvx', 'ruff', 'format', '--stdin-filename', path, '-']
  else if (ext === 'go') argv = ['gofmt']
  if (!argv) return { text, diagnostics: [] }

  const ran = await $.process
    .run(argv, { stdin: text, env: NO_COLOR, timeoutMs: 20_000 })
    .catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  if (ran.exitCode === 0 && ran.stdout !== '') return { text: ran.stdout, diagnostics: [] }

  const message = firstLine(ran.stderr) || `${argv[0]} exited ${ran.exitCode}`
  const err = plain(ran.stderr)
  const at = /:(\d+):(\d+)/.exec(err)
  const row = /^\s*(\d+) \|/m.exec(err)

  return {
    text,
    diagnostics: [{
      line: at ? Number(at[1]) : row ? Number(row[1]) : 1,
      col: at ? Number(at[2]) : 1,
      code: 'format',
      message,
    }],
  }
}

async function lint($: EngineInterface, path: string): Promise<Diagnostic[]> {
  const ext = extOf(path)
  if (DENO_LINT.has(ext)) {
    const ran = await $.process
      .run(['deno', 'lint', '--json', path], { env: NO_COLOR, timeoutMs: 20_000 })
      .catch(() => undefined)
    if (!ran) return []
    try {
      const out = JSON.parse(ran.stdout) as {
        diagnostics: { range: { start: { line: number; col: number } }; code: string; message: string }[]
      }
      return out.diagnostics.map(one => ({
        line: one.range.start.line,
        col: one.range.start.col + 1,
        code: one.code,
        message: plain(one.message),
      }))
    } catch {
      return []
    }
  }
  if (ext === 'py') {
    const ran = await $.process
      .run(['uvx', 'ruff', 'check', '--output-format', 'json', path], { env: NO_COLOR, timeoutMs: 30_000 })
      .catch(() => undefined)
    if (!ran) return []
    try {
      const out = JSON.parse(ran.stdout) as {
        location: { row: number; column: number }; code: string | null; message: string
      }[]
      return out.map(one => ({
        line: one.location.row,
        col: one.location.column,
        code: one.code ?? 'syntax',
        message: plain(one.message),
      }))
    } catch {
      return []
    }
  }

  return []
}

async function check($: EngineInterface, path: string, extra: Diagnostic[]): Promise<Diagnostic[]> {
  const found = [...extra, ...(await lint($, path))]

  return found.sort((a, b) => a.line - b.line || a.col - b.col).slice(0, 200)
}

function docFor(path: string, rev: number, text: string, diagnostics: Diagnostic[], status: string, savedHash?: string): Doc {
  return {
    path,
    rev,
    size: text.length,
    hash: hashText(text),
    chunks: Math.max(1, Math.ceil(text.length / PIECE)),
    ...(savedHash === undefined ? {} : { savedHash }),
    diagnostics,
    status,
  }
}

// The hooks hold `text` as version `rev` of `path`
function hold(path: string, rev: number, text: string): void {
  content = { rev, text }
  mirror = { path, rev, lines: split(text) }
  isMirrorDirty = false
}

async function propsFor($: EngineInterface, reply?: Reply): Promise<EditorProps | undefined> {
  const current = await read($, doc)
  if (!current) return undefined

  return {
    ...current,
    ...(lastFocused === undefined ? {} : { isFocused: lastFocused }),
    wheel: await read($, wheel),
    paste: await read($, paste),
    ...(reply ? { reply } : {}),
  }
}

async function saveMirror($: EngineInterface): Promise<void> {
  const current = await read($, doc)
  if (!current || !mirror || mirror.path !== current.path) return

  const posted = mirror.lines.join('\n')
  const formatted = await format($, current.path, posted)
  await $.fs.write(current.path, formatted.text)
  const diagnostics = await check($, current.path, formatted.diagnostics)
  const status = formatted.text !== posted ? 'saved, formatted' : 'saved'
  const rev = current.rev + 1
  hold(current.path, rev, formatted.text)
  await update($, doc, () => docFor(current.path, rev, formatted.text, diagnostics, status, hashText(posted)))
}

async function flush($: EngineInterface): Promise<void> {
  if (isMirrorDirty) await saveMirror($)
}

async function openFile($: EngineInterface, typed: string): Promise<string> {
  await flush($)
  const path = await absolute($, typed)
  const exists = await $.fs.exists(path)
  let text = ''
  try {
    text = exists ? await $.fs.read(path) : ''
  } catch (error) {
    return `${typed} cannot be opened: ${String(error)}`
  }

  const prev = await read($, doc)
  const rev = (prev?.rev ?? 0) + 1
  const diagnostics = exists ? await check($, path, []) : []
  hold(path, rev, text)
  await update($, doc, () => docFor(path, rev, text, diagnostics, exists ? 'opened' : 'new file'))
  await $.ui.open({ id: PANE, title: path.slice(path.lastIndexOf('/') + 1), focus: true })

  return `Editing ${path}. Click the pane to type; Esc returns the keyboard.`
}

async function reload($: EngineInterface, path: string): Promise<void> {
  const current = await read($, doc)
  if (!current || current.path !== path) return

  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined || hashText(text) === current.hash) return
  // Unsaved edits win over the change on disk until the next save
  if (isMirrorDirty) {
    await update($, doc, last => (last ? { ...last, status: 'changed on disk' } : last))
    return
  }

  const diagnostics = await check($, path, [])
  const rev = current.rev + 1
  hold(path, rev, text)
  await update($, doc, () => docFor(path, rev, text, diagnostics, 'changed on disk'))
}

async function answerChunk($: EngineInterface, seq: number, rev: number, index: number): Promise<EditorProps | undefined> {
  const current = await read($, doc)
  if (!current || current.rev !== rev) return propsFor($, { seq })
  if (content?.rev !== rev) {
    const text = await $.fs.read(current.path).catch(() => '')
    hold(current.path, rev, text)
  }
  const text = content?.text ?? ''

  return propsFor($, { seq, chunk: text.slice(index * PIECE, (index + 1) * PIECE) })
}

async function answerSync(
  $: EngineInterface,
  data: Extract<EditorRequest, { type: 'sync' }>,
): Promise<EditorProps | undefined> {
  if (data.seq <= lastSeq) return propsFor($, { seq: data.seq })
  lastSeq = data.seq
  const stale = () => propsFor($, { seq: data.seq, isStale: true })

  const current = await read($, doc)
  const first = data.ops[0]
  const isFresh = first !== undefined && 'reset' in first
  const isOurs = mirror !== undefined && mirror.path === current?.path
  if (!current || data.base !== current.rev || (!isOurs && !isFresh)) return stale()

  const lines = applyOps(isOurs ? mirror!.lines : [''], data.ops)
  if (!lines) return stale()
  mirror = { path: current.path, rev: current.rev, lines }
  if (data.ops.length > 0) isMirrorDirty = true
  if (data.save !== undefined) {
    if (hashText(lines.join('\n')) !== data.save) return stale()
    await saveMirror($)
  }

  return propsFor($, { seq: data.seq })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'edit',
      description: 'Open a file in the editor pane',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'open',
      isDeferred: false,
      description:
        'Open a file in the person\'s editor pane (syntax highlighting, lint, auto save, auto format). ' +
        'Call it first whenever the person says they want to change, edit, open or look at a file ("我要改 X", "open X"), unless they also say exactly what Claude should change. Creates the file when missing.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path, or relative to the session root' } },
        required: ['path'],
      },
    })

    return next(e)
  })

  on('command.run', { command: 'edit' }, async ($, e) => {
    const typed = e.args.trim()
    if (typed !== '') return { text: await openFile($, typed) }

    const current = await read($, doc)
    if (!current) return { text: 'Usage: /edit <path>' }
    await $.ui.open({ id: PANE, focus: true })

    return { text: `Editing ${current.path}.` }
  })

  on('tool.call', { tool: 'mcp__edit-mod__open' }, async ($, e) => {
    const path = (e as unknown as { path?: unknown }).path
    if (typeof path !== 'string' || path.trim() === '') return { deny: 'path is required' }
    const text = await openFile($, path.trim())

    return { result: text, text, isReadOnly: true }
  })

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const data = e.data as EditorMessage | undefined
    if (!data) return next(e)
    if ('isActive' in data && typeof data.isActive === 'boolean') isEditorActive = data.isActive
    if (data.type === 'active') return {}
    if (data.type === 'copy') {
      if (typeof data.text === 'string') await $.ui.copy({ text: data.text, surface: e.surface })
      return {}
    }
    const props = data.type === 'chunk'
      ? await answerChunk($, data.seq, data.rev, data.index)
      : data.type === 'sync' ? await answerSync($, data) : undefined

    return props ? { props } : next(e)
  })

  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    await update($, wheel, last => ({ seq: last.seq + 1, by: e.by }))

    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await flush($).catch(() => undefined)

    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    if (e.key) isEditorActive = false
    const isPaste = !e.key && e.inputText !== ''
    if (!isEditorActive || !isPaste) return next(e)

    await update($, paste, last => ({ seq: last.seq + 1, text: e.inputText }))

    return { text: e.text, cursor: e.cursor }
  })

  on('prompt.submit', async ($, e, next) => {
    await flush($).catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($).catch(() => undefined)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.tool === 'Edit' || e.tool === 'Write') {
      await reload($, e.file_path).catch(() => undefined)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Client } = $.ui.resolve(e)
    const current = await read($, doc)
    if (!current) return <Text dimColor>/edit &lt;path&gt;</Text>

    const rows = Math.max(6, e.props.scroll.bodyRows)
    lastFocused = e.props.isFocused
    const props = await propsFor($)

    return (
      <Box flexDirection="column" height={rows}>
        <Client key="editor" module="./editor.tsx" props={props} height={rows} flexGrow={1} />
      </Box>
    )
  })
}
