<!-- 翻译自 README.md @ docs/readme-template-v2。只翻 "For AI agents" 以上的章节，英文版更新时一起改。 -->

<div align="center">

<h1>edit-mod</h1>

<p><strong>Claude Code 里的代码编辑器 pane，有语法高亮、lint，保存时自动格式化。</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/edit-mod/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/edit-mod/actions)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-mod-d97757?style=flat-square)](https://github.com/anthropics/claude-code/tree/main/mods)
[![License](https://img.shields.io/github/license/zyx1121/edit-mod?style=flat-square)](LICENSE)

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文**

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

小改动自己动手，常常比写 prompt 快。切到另一个编辑器又会打断专注。edit-mod 把文件开在对话旁边的 pane，你和 Claude 在同一个终端里改同一个文件。

## 功能

- **用 prompt 打开文件**：说「我要改 demo.ts」，Claude 就用 `open` 工具打开 pane。`/edit <路径>` 也可以。
- **高亮与 lint**：引擎负责语法高亮。lint 错误会标红行号，并列在代码下方。
- **语言服务器**：边输入边出现错误，还有自动补全、hover、跳到定义、重命名。TypeScript、JavaScript、JSON、Markdown 用 `deno lsp`，Python 通过 `uvx` 用 basedpyright。
- **保存时格式化**：JavaScript、TypeScript、JSON、CSS、Markdown、YAML、HTML 用 `deno fmt`，Python 用 `ruff`，Go 用 `gofmt`。
- **macOS 按键**：Cmd 和 Option 搭配方向键与 Delete，还有 Cmd+S、Cmd+X、Cmd+V。
- **查找替换**：Ctrl+F 打开查找栏，标出所有匹配处，可以替换一个或全部。
- **多光标**：Option+点击加一个光标。Option+D 把选中文本的下一个匹配处加为光标。
- **鼠标**：点击放置光标，双击选词，三击选整行，拖动选择并复制，滚轮滚动。
- **跟着 Claude**：Claude 改了打开的文件，pane 会重新加载。

## 快速开始

Function hooks 还在抢先体验阶段。在 shell 配置文件里打开它：

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

接着在 Claude Code 安装这个 mod：

```
/plugin marketplace add zyx1121/edit-mod
/plugin install edit-mod@edit-mod
```

打开新的 session，执行 `/edit <路径>`。点一下 pane 就能输入，按 Esc 把键盘还给 prompt。

## 使用方式

| 按键或动作 | 作用 |
|------------|------|
| Cmd+S | 保存并格式化 |
| Cmd+X、Cmd+V | 剪切选区，粘贴到光标位置 |
| 拖动、Shift 加方向键 | 选择。拖动会顺便复制 |
| 双击、三击 | 选词、选整行 |
| Option+Z | 撤销 |
| Option+Shift+Z、Ctrl+Y | 重做 |
| Ctrl+F | 打开或关闭查找栏 |
| Option+D | 选词，再把下一个匹配处加为光标 |
| Option+点击 | 加一个光标 |
| Up、Down、Tab 或 Enter | 选择并接受补全 |
| F12、Ctrl+点击 | 跳到定义 |
| F2 | 重命名，所有用到的文件一起改 |
| 鼠标停住 | 显示下面的类型和错误 |
| Cmd+Left、Cmd+Right | 跳到行首或行尾 |
| Option+Left、Option+Right | 跳一个词 |
| Cmd+Delete、Option+Delete | 删到行首、删一个词 |
| 滚轮 | 每格滚 3 行 |

在查找栏输入要找的文本。Enter 跳到下一个，Shift+Enter 跳到上一个。Tab 切到替换栏，在那里按 Enter 替换一个，Option+Enter 全部替换。

鼠标移出 pane、提交 prompt、关闭 pane、session 结束时也会保存。不会定时保存。

### Ghostty 按键

Ghostty 不会把 Cmd 加字母传给程序。在 Ghostty 配置里加这几行，Cmd+S、Cmd+X 和编辑器背景才会正常：

```
background-opacity-cells = true
keybind = cmd+s=text:\x1bs
keybind = cmd+x=text:\x1bx
```

之后在所有程序里，Cmd+S 和 Cmd+X 都会发送 Option+S 和 Option+X。

## 运作方式

- `hooks/register.tsx` 注册 `/edit` 和 `open` 工具，负责读写文件，每次保存时运行格式化和 lint。
- `bridge/lsp.ts` 是一个 Bun 小程序，在 Unix socket 上为语言服务器做前台。mod 只能一次写完子进程的 stdin，所以 hooks 用 `$.http.fetch` 调用它，错误推送从它的 stdout 回来。
- `hooks/editor.tsx` 是 `Client` surface module。它保存文本、光标、选区和撤销记录，只画可见的行。
- 编辑器把每次修改用小的范围操作发给 hooks，hooks 保留一份同步的文本。保存只发文本的哈希值，对不上时编辑器会把全文重发一次。
- 打开文件时全文每批 60000 字符发进编辑器，因为引擎限制每条消息 100000 字符。
- 点进或在编辑器输入后，粘贴会进编辑器，直到你再在 prompt 输入。

## 限制

- 文件上限 4 MiB，是引擎一次能读的最大量。1 MB 的文件大约 2 秒打开。
- 只有语言服务器支持的文件会边输入边 lint，其他文件在保存时 lint。
- 重命名会直接把其他被改到的文件写回磁盘。编辑器的撤销只会还原打开的文件。
- Cmd+Z 留给 Ghostty，它用来重新打开关掉的标签页。Claude Code 会先拦下 Ctrl+Z、Ctrl+D、Ctrl+C，所以撤销用 Option+Z。

## 其他

给 AI agent 的结构化信息与开发说明在[英文版](README.md#for-ai-agents)。

## 授权

[MIT](LICENSE)
