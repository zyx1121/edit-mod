// The LSP bridge: an HTTP server on a Unix socket in front of language servers.
//
// A hooks module can write a child's stdin only once, so it cannot speak LSP to a
// server itself. The hooks start this bridge with `bun bridge/lsp.ts <socket> <root>`,
// call it with `$.http.fetch` over the socket, and read what the servers push
// (diagnostics) as JSON lines on its stdout.

import { unlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type Spec = {
  id: string
  argv: string[]
  exts: Record<string, string>
  init: Json
}

// Each server and the file extensions it takes, with their LSP language ids
const SPECS: Spec[] = [
  {
    id: 'deno',
    argv: ['deno', 'lsp'],
    exts: {
      ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
      json: 'json', jsonc: 'jsonc', md: 'markdown',
    },
    init: { enable: true, lint: true },
  },
  {
    id: 'python',
    argv: ['uvx', '--from', 'basedpyright', 'basedpyright-langserver', '--stdio'],
    exts: { py: 'python' },
    init: {},
  },
]

type Waiter = { resolve: (value: Json) => void; reject: (error: Error) => void }

type Server = {
  spec: Spec
  write: (message: Json) => void
  request: (method: string, params: Json) => Promise<Json>
  ready: Promise<boolean>
  versions: Map<string, number>
}

const [socket, root = process.cwd()] = process.argv.slice(2)
if (!socket) {
  console.error('usage: bun bridge/lsp.ts <socket> [root]')
  process.exit(2)
}

const servers = new Map<string, Server>()

function emit(message: Json): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function specFor(path: string): { spec: Spec; languageId: string } | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  for (const spec of SPECS) {
    const languageId = spec.exts[ext]
    if (languageId) return { spec, languageId }
  }

  return undefined
}

// Splits the server's stdout into LSP messages: a Content-Length header, then a body
function reader(onMessage: (message: { [key: string]: Json }) => void): (bytes: Uint8Array) => void {
  let buffer = new Uint8Array(0)
  const decoder = new TextDecoder()

  return bytes => {
    const joined = new Uint8Array(buffer.length + bytes.length)
    joined.set(buffer)
    joined.set(bytes, buffer.length)
    buffer = joined
    for (;;) {
      let end = -1
      for (let i = 0; i + 3 < buffer.length; i++) {
        if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
          end = i
          break
        }
      }
      if (end < 0) return
      const header = decoder.decode(buffer.slice(0, end))
      const length = Number(/Content-Length: *(\d+)/i.exec(header)?.[1] ?? '0')
      if (buffer.length < end + 4 + length) return
      const body = decoder.decode(buffer.slice(end + 4, end + 4 + length))
      buffer = buffer.slice(end + 4 + length)
      try {
        onMessage(JSON.parse(body))
      } catch {
        // A body that is not JSON is skipped
      }
    }
  }
}

function start(spec: Spec): Server {
  const child = Bun.spawn(spec.argv, { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const encoder = new TextEncoder()
  const waiters = new Map<number, Waiter>()
  let nextId = 1

  const write = (message: Json) => {
    const body = encoder.encode(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }))
    child.stdin.write(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`))
    child.stdin.write(body)
    child.stdin.flush()
  }

  const request = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
    const id = nextId++
    waiters.set(id, { resolve, reject })
    write({ id, method, params })
    setTimeout(() => {
      if (waiters.delete(id)) reject(new Error(`${method} timed out`))
    }, 10_000)
  })

  // What the server asks of the client: settings, progress tokens, registrations
  const answer = (id: Json, method: string, params: Json) => {
    let result: Json = null
    if (method === 'workspace/configuration') {
      const items = (params as { items?: Json[] })?.items ?? []
      result = items.map(() => spec.init)
    }
    write({ id, result })
  }

  const read = reader(message => {
    const id = message.id
    const method = typeof message.method === 'string' ? message.method : undefined
    if (method && id !== undefined) {
      if (process.env.LSP_TRACE) emit({ type: 'trace', method, params: message.params ?? null })
      return answer(id, method, message.params ?? null)
    }
    if (method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri: string; diagnostics: Json[] }
      emit({ type: 'diagnostics', path: fileURLToPath(params.uri), diagnostics: params.diagnostics })
      return
    }
    if (typeof id === 'number') {
      const waiter = waiters.get(id)
      if (!waiter) return
      waiters.delete(id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result ?? null)
    }
  })

  void (async () => {
    for await (const bytes of child.stdout) read(bytes)
    servers.delete(spec.id)
    emit({ type: 'exit', server: spec.id })
  })()

  const rootUri = pathToFileURL(root).href
  const ready = request('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'root' }],
    initializationOptions: spec.init,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        publishDiagnostics: { relatedInformation: false },
        completion: { completionItem: { snippetSupport: false, documentationFormat: ['plaintext'] } },
        hover: { contentFormat: ['plaintext', 'markdown'] },
        definition: { linkSupport: false },
        rename: { prepareSupport: false },
      },
      workspace: { configuration: true, workspaceEdit: { documentChanges: true } },
    },
  })
    .then(() => {
      write({ method: 'initialized', params: {} })
      return true
    })
    .catch(() => false)

  return { spec, write, request, ready, versions: new Map() }
}

async function serverFor(path: string): Promise<{ server: Server; uri: string; languageId: string } | undefined> {
  const found = specFor(path)
  if (!found) return undefined
  let server = servers.get(found.spec.id)
  if (!server) {
    try {
      server = start(found.spec)
    } catch {
      return undefined
    }
    servers.set(found.spec.id, server)
  }
  if (!(await server.ready)) return undefined

  return { server, uri: pathToFileURL(path).href, languageId: found.languageId }
}

type Body = { path: string; text?: string; changes?: Json[]; method?: string; params?: { [key: string]: Json } }

async function handle(route: string, body: Body): Promise<Json> {
  const found = await serverFor(body.path)
  if (!found) return { ok: false }
  const { server, uri, languageId } = found
  const textDocument = { uri }
  switch (route) {
    case '/open': {
      if (server.versions.has(uri)) server.write({ method: 'textDocument/didClose', params: { textDocument } })
      server.versions.set(uri, 1)
      server.write({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version: 1, text: body.text ?? '' } } })
      return { ok: true }
    }
    case '/change': {
      const version = (server.versions.get(uri) ?? 1) + 1
      server.versions.set(uri, version)
      server.write({ method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: body.changes ?? [] } })
      return { ok: true }
    }
    case '/save': {
      server.write({ method: 'textDocument/didSave', params: { textDocument } })
      return { ok: true }
    }
    case '/close': {
      server.versions.delete(uri)
      server.write({ method: 'textDocument/didClose', params: { textDocument } })
      return { ok: true }
    }
    case '/request': {
      try {
        const result = await server.request(body.method ?? '', { ...body.params, textDocument })
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }
  }

  return { ok: false }
}

try {
  unlinkSync(socket)
} catch {
  // No old socket
}

Bun.serve({
  unix: socket,
  async fetch(request) {
    const route = new URL(request.url).pathname
    const body = (await request.json().catch(() => ({}))) as Body
    if (typeof body.path !== 'string') return Response.json({ ok: false })

    return Response.json(await handle(route, body))
  },
})

emit({ type: 'ready' })

// The hooks end the bridge by ending its process; the socket goes with it
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    try {
      unlinkSync(socket)
    } catch {
      // Already gone
    }
    process.exit(0)
  })
}
