# edit-mod

Claude Code mod (a function-hooks plugin). `hooks/register.tsx` exports `register(on, options)`. It registers `/edit` and the `open` tool, reads and writes files, runs the formatter and the linter, and draws the `editor` pane. `hooks/editor.tsx` is the `Client` surface module: it holds the text, the caret and the selection, takes keys and pointer events, and draws the visible lines. Read [README.md](README.md) first.

## Rules

- The editor holds the document. The hooks hold the file on disk. They talk only through `ui.message` posts and `Client` props.
- Props and posts have a limit of 100000 characters. Never send the full text twice in one message. Use `hashText` from `hooks/hash.ts` to name a text.
- Save only on Cmd+S, when the pointer leaves the editor, on a prompt submit, on pane close and on session end. Do not add a timer.
- Draw only the visible lines. Each run of `Code` lines sits in a `Box` with a fixed height, because `Code` grows into free room.
- Draw the caret and the selection as `position="absolute"` overlays on the `Code` run, so the caret line keeps its colors. Count cells with `cells()`, because wide characters take 2 cells.
- Strip ANSI escapes and control characters from tool output before it goes into a tree.
- `types/claude-code.d.ts` is the engine contract. Copy it, do not edit it.
- Repository documents and code comments are English. No em dashes.

## Verify

```sh
bunx -p typescript tsc -p tsconfig.json
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
```

No node_modules. For a real check, run `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .` in a tmux window of 170 columns. Then run `/edit <file>`, click the pane and type. Send SGR mouse sequences with `tmux send-keys -l` to click, drag and scroll.
