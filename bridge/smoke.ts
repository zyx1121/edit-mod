// A smoke test of the LSP bridge against `deno lsp`: run `bun bridge/smoke.ts`.
// It starts the bridge, opens a file, and checks diagnostics, a change,
// completion, hover, definition and rename. Exits non-zero on a failure.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const folder = mkdtempSync(join(tmpdir(), 'edit-mod-smoke-'))
const socket = join(folder, 'bridge.sock')
const file = join(folder, 'a.ts')
const text = 'var unused = 1;\nexport function shout(s: string) {\n  return s.toUpperCase();\n}\nshout("a");\n'
writeFileSync(file, text)

const bridge = Bun.spawn(['bun', join(import.meta.dir, 'lsp.ts'), socket, folder], { stdout: 'pipe', stderr: 'inherit' })
const lines: { type: string; path?: string; diagnostics?: { message: string }[] }[] = []
void (async () => {
  let buffer = ''
  for await (const bytes of bridge.stdout) {
    buffer += new TextDecoder().decode(bytes)
    let end = buffer.indexOf('\n')
    while (end >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
      end = buffer.indexOf('\n')
    }
  }
})()

async function waitFor<T>(what: string, find: () => T | undefined, ms = 20_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const found = find()
    if (found !== undefined) return found
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function call(route: string, body: unknown): Promise<{ ok: boolean; result?: unknown }> {
  const response = await fetch(`http://lsp${route}`, { method: 'POST', body: JSON.stringify(body), unix: socket })
  return response.json() as Promise<{ ok: boolean; result?: unknown }>
}

function check(name: string, isOk: boolean, detail: unknown): void {
  console.log(`${isOk ? 'ok  ' : 'FAIL'} ${name}`)
  if (!isOk) {
    console.log(JSON.stringify(detail, null, 2).slice(0, 2000))
    process.exitCode = 1
  }
}

const position = (line: number, character: number) => ({ position: { line, character } })

try {
  await waitFor('ready', () => lines.find(line => line.type === 'ready'))
  await call('/open', { path: file, text })
  const first = await waitFor('lint diagnostics', () =>
    lines.find(line => line.type === 'diagnostics' && line.diagnostics?.some(d => d.message.includes('`var`'))))
  check('diagnostics include the deno lint rule no-var', true, first)

  await call('/change', { path: file, changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'let' }] })
  const fixed = await waitFor('diagnostics after the change', () => {
    const last = [...lines].reverse().find(line => line.type === 'diagnostics')
    return last && !last.diagnostics?.some(d => d.message.includes('`var`')) ? last : undefined
  })
  check('a change clears the no-var diagnostic', true, fixed)

  const completion = await call('/request', { path: file, method: 'textDocument/completion', params: position(2, 11) })
  const items = (completion.result as { items?: { label: string }[] } | undefined)?.items ?? []
  check('completion after `s.` offers toUpperCase', items.some(item => item.label === 'toUpperCase'), completion)

  const hover = await call('/request', { path: file, method: 'textDocument/hover', params: position(1, 17) })
  check('hover on shout names its type', JSON.stringify(hover.result).includes('shout'), hover)

  const definition = await call('/request', { path: file, method: 'textDocument/definition', params: position(4, 1) })
  check('definition of the call lands on line 2', JSON.stringify(definition.result).includes('"line":1'), definition)

  const rename = await call('/request', { path: file, method: 'textDocument/rename', params: { ...position(1, 17), newName: 'yell' } })
  const edits = JSON.stringify(rename.result)
  check('rename edits the declaration and the call', (edits.match(/"newText":"yell"/g) ?? []).length === 2, rename)
} catch (error) {
  check('smoke', false, String(error))
} finally {
  bridge.kill()
  rmSync(folder, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
