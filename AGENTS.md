# edit-mod

Claude Code mod (a function-hooks plugin). `hooks/register.tsx` exports `register(on, options)`. It registers `/edit` and the `open` tool, reads and writes files, runs the formatter and the linter, and draws the `editor` pane. `hooks/editor.tsx` is the `Client` surface module: it holds the text, the caret and the selection, takes keys and pointer events, and draws the visible lines. Read [README.md](README.md) first.

## Rules

- The editor holds the document. The hooks hold a mirror of it and the file on disk. They talk only through `ui.message` posts and `Client` props.
- The sync is in `hooks/editor/sync.ts`. The editor sends `sync` requests with range ops and `chunk` requests for downloads. One request is out at a time, and the editor sends it again until the reply with its `seq` comes. A later post in the same frame replaces an earlier one, so never rely on a post without a reply.
- A change larger than one post goes up in several `sync` requests marked `more`. The hooks write only `whole`, the mirror after a request without `more`. A flush waits up to 2 seconds for the last piece and writes nothing when it does not come: half a change, or the text from before it, is worse than the file as it was.
- Props and posts have a limit of 100000 characters. Text moves in pieces of `PIECE`. Use `hashText` from `hooks/hash.ts` to name a text.
- Compare props by content, not by reference: each redraw hands new objects, and a `setState` on every render unmounts the `Client`.
- Save only on Cmd+S, when the pointer leaves the editor, on a prompt submit, on pane close and on session end. Do not add a timer.
- Draw only the visible lines. Each run of `Code` lines sits in a `Box` with a fixed height, because `Code` grows into free room.
- Draw the caret and the selection as `position="absolute"` overlays on the `Code` run, so the caret line keeps its colors. Count cells with `cells()`, because wide characters take 2 cells.
- Every edit is a range replacement per caret in `hooks/editor/model.ts`. Add a new edit as a `make` function for `applyEdits`, so it works with many carets. Test it in `tests/model.test.ts`.
- Claude Code takes Ctrl+C, Ctrl+D and Ctrl+Z before a `Client` sees them, and a terminal sends Ctrl+H as Backspace. Do not bind them. Option keys arrive as `meta`.
- A rename writes other files. Before it writes, the hooks give the server each file's disk text and ask again, then skip a file that changed on disk since. After it writes, the server gets the new text. Input waits while a rename is out.
- The language servers sit behind `bridge/lsp.ts`. `hooks/lsp.ts` starts it, forwards every applied op to it in order, and maps its shapes to the editor's. Test the bridge with `bun bridge/smoke.ts`.
- The engine passes `$` only to a function declared at the top of a file or imported from the mod, never to a callback. A `read` or `update` takes an atom declared in the same file, so `hooks/state.ts` declares `doc` again under the same address.
- A function key reaches a `Client` as its raw escape sequence (F2 is `\u001bOQ`). A terminal can fold several typed characters into one key, so text fields take the whole `k.key`.
- Strip ANSI escapes and control characters from tool output before it goes into a tree.
- `types/claude-code.d.ts` is the engine contract. Copy it, do not edit it.
- Repository documents and code comments are English. No em dashes.

## Verify

```sh
bunx -p typescript tsc -p tsconfig.json
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
```

No node_modules. For a real check, run `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .` in a tmux window of 170 columns. Then run `/edit <file>`, click the pane and type. Send SGR mouse sequences with `tmux send-keys -l` to click, drag and scroll.
