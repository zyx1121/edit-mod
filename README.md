<div align="center">

<h1>edit-mod</h1>

<p><strong>A code editor pane inside Claude Code, with highlighting, lint and format on save.</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/edit-mod/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/edit-mod/actions)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-mod-d97757?style=flat-square)](https://github.com/anthropics/claude-code/tree/main/mods)
[![License](https://img.shields.io/github/license/zyx1121/edit-mod?style=flat-square)](LICENSE)

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

</div>

```
│1 const a = { b: 1 };
│2 export function add(x: number, y: number) {
│3   return x + y▌
│4 }
│
│1:7 no-unused-vars `a` is never used
│demo.ts  3:15  saved, formatted  1 problems
```

A small edit in your own hands is often faster than a prompt. A switch to another editor breaks your focus. edit-mod opens the file in a pane beside the transcript, so you and Claude work on the same file in the same terminal.

## Features

- **Open from a prompt**: say "I want to edit demo.ts", and Claude opens the pane with the `open` tool. `/edit <path>` does the same.
- **Highlighting and lint**: the engine highlights the code. Lint errors mark the line number and show below the code.
- **Format on save**: `deno fmt` for JavaScript, TypeScript, JSON, CSS, Markdown, YAML and HTML. `ruff` for Python and `gofmt` for Go.
- **macOS keys**: Cmd and Option with the arrows and Delete, Cmd+S, Cmd+X and Cmd+V. Undo is Ctrl+Z.
- **Mouse**: click to place the caret, drag to select and copy, scroll with the wheel.
- **Follows Claude**: when Claude edits the open file, the pane reloads it.

## Quick start

Function hooks are in early access. Turn them on in your shell profile:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Then install the mod in Claude Code:

```
/plugin marketplace add zyx1121/edit-mod
/plugin install edit-mod@edit-mod
```

Start a new session and run `/edit <path>`. Click the pane to type. Esc gives the keys back to the prompt.

## Usage

| Key or action | Does |
|---------------|------|
| Cmd+S | Save and format |
| Cmd+X, Cmd+V | Cut the selection, paste at the caret |
| Drag, Shift with an arrow | Select. A drag copies the selection |
| Ctrl+Z | Undo |
| Cmd+Left, Cmd+Right | Go to the start or end of the line |
| Option+Left, Option+Right | Go one word |
| Cmd+Delete, Option+Delete | Delete to the line start, delete one word |
| Wheel | Scroll 3 lines a tick |

The pane also saves when the pointer leaves it, when you submit a prompt, when you close the pane and when the session ends. It never saves on a timer.

### Ghostty keys

Ghostty does not send Cmd with a letter to the program. Add these lines to the Ghostty config, so that Cmd+S, Cmd+X and the editor background work:

```
background-opacity-cells = true
keybind = cmd+s=text:\x1bs
keybind = cmd+x=text:\x1bx
```

Cmd+S and Cmd+X then send Option+S and Option+X in every program.

## How it works

- `hooks/register.tsx` registers `/edit` and the `open` tool, reads and writes the file, and runs the formatter and the linter on each save.
- `hooks/editor.tsx` is a `Client` surface module. It holds the text, the caret, the selection and the undo history. It draws only the visible lines.
- A paste goes to the editor after you click or type in it, until you type in the prompt again.

## Limits

- A file has a limit of 90000 characters, because the engine limits a message to 100000 characters.
- The caret line and the selected lines show without colors.
- Lint runs on save, not as you type. There is no completion yet.
- Cmd+Z stays with Ghostty, which uses it to reopen a closed tab.

## For AI agents

Facts for coding agents and LLM tools. The rules for changing the code are in [AGENTS.md](AGENTS.md).

- **Summary**: Claude Code function-hooks mod that opens a file in a code editor pane, with highlighting, lint, format on save, selection and clipboard.
- **Type**: plugin
- **Interfaces**: slash command `/edit <path>`, MCP tool `mcp__edit-mod__open`, `Pane` UI with a `Client` editor
- **Install**: `/plugin marketplace add zyx1121/edit-mod`, then `/plugin install edit-mod@edit-mod`
- **Run**: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
- **Verify**: `bunx -p typescript tsc -p tsconfig.json && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
- **Config**: none
- **Secrets**: none
- **Limits**: 90000 characters a file. Formatters `deno`, `uvx ruff` and `gofmt` must be on the PATH.

## Development

```sh
bunx -p typescript tsc -p tsconfig.json                    # typecheck
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .   # the engine's test harness
```

`types/claude-code.d.ts` is the engine contract that Claude Code writes for mods. When the engine changes, copy the new version and let the typecheck show what moved.

## License

[MIT](LICENSE)
