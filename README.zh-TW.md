<!-- 翻譯自 README.md @ docs/readme-template-v2。只翻 "For AI agents" 以上的章節，英文版更新時一起改。 -->

<div align="center">

<h1>edit-mod</h1>

<p><strong>Claude Code 裡的程式碼編輯器 pane，有語法高亮、lint，存檔時自動格式化。</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/edit-mod/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/edit-mod/actions)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-mod-d97757?style=flat-square)](https://github.com/anthropics/claude-code/tree/main/mods)
[![License](https://img.shields.io/github/license/zyx1121/edit-mod?style=flat-square)](LICENSE)

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md)

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

小改動自己動手，常常比寫 prompt 快。切到另一個編輯器又會打斷專注。edit-mod 把檔案開在對話旁邊的 pane，你和 Claude 在同一個終端機改同一個檔案。

## 功能

- **用 prompt 開檔**：說「我要改 demo.ts」，Claude 就用 `open` 工具打開 pane。`/edit <路徑>` 也可以。
- **高亮與 lint**：引擎負責語法高亮。lint 錯誤會標紅行號，並列在程式碼下方。
- **存檔時格式化**：JavaScript、TypeScript、JSON、CSS、Markdown、YAML、HTML 用 `deno fmt`，Python 用 `ruff`，Go 用 `gofmt`。
- **macOS 按鍵**：Cmd 和 Option 搭配方向鍵與 Delete，還有 Cmd+S、Cmd+X、Cmd+V。
- **搜尋取代**：Ctrl+F 打開搜尋列，標出所有符合的地方，可以取代一個或全部。
- **多游標**：Option+點擊加一個游標。Option+D 把選取文字的下一個符合處加成游標。
- **滑鼠**：點擊放游標，雙擊選字，三擊選整行，拖曳選取並複製，滾輪捲動。
- **跟著 Claude**：Claude 改了開著的檔案，pane 會重新載入。

## 快速開始

Function hooks 還在搶先體驗階段。在 shell 設定檔打開它：

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

接著在 Claude Code 安裝這個 mod：

```
/plugin marketplace add zyx1121/edit-mod
/plugin install edit-mod@edit-mod
```

開新的 session，執行 `/edit <路徑>`。點一下 pane 就能打字，按 Esc 把鍵盤還給 prompt。

## 使用方式

| 按鍵或動作 | 作用 |
|------------|------|
| Cmd+S | 存檔並格式化 |
| Cmd+X、Cmd+V | 剪下選取，貼在游標位置 |
| 拖曳、Shift 加方向鍵 | 選取。拖曳會順便複製 |
| 雙擊、三擊 | 選字、選整行 |
| Option+Z | 復原 |
| Option+Shift+Z、Ctrl+Y | 重做 |
| Ctrl+F | 打開或關閉搜尋列 |
| Option+D | 選字，再把下一個符合處加成游標 |
| Option+點擊 | 加一個游標 |
| Cmd+Left、Cmd+Right | 跳到行首或行尾 |
| Option+Left、Option+Right | 跳一個字 |
| Cmd+Delete、Option+Delete | 刪到行首、刪一個字 |
| 滾輪 | 每格捲 3 行 |

在搜尋列輸入要找的字。Enter 跳到下一個，Shift+Enter 跳到上一個。Tab 切到取代欄，在那裡按 Enter 取代一個，Option+Enter 全部取代。

滑鼠移出 pane、送出 prompt、關掉 pane、session 結束時也會存檔。不會定時存檔。

### Ghostty 按鍵

Ghostty 不會把 Cmd 加字母傳給程式。在 Ghostty 設定加這幾行，Cmd+S、Cmd+X 和編輯器背景才會正常：

```
background-opacity-cells = true
keybind = cmd+s=text:\x1bs
keybind = cmd+x=text:\x1bx
```

之後在所有程式裡，Cmd+S 和 Cmd+X 都會送出 Option+S 和 Option+X。

## 運作方式

- `hooks/register.tsx` 註冊 `/edit` 和 `open` 工具，負責讀寫檔案，每次存檔時跑格式化和 lint。
- `hooks/editor.tsx` 是 `Client` surface module。它保存文字、游標、選取和復原紀錄，只畫看得到的行。
- 編輯器把每次修改用小的範圍操作送給 hooks，hooks 保留一份同步的文字。存檔只送文字的雜湊值，對不上時編輯器會把全文重送一次。
- 開檔時全文每批 60000 字元送進編輯器，因為引擎限制每則訊息 100000 字元。
- 點進或在編輯器打字後，貼上會進編輯器，直到你再在 prompt 打字。

## 限制

- 檔案上限 4 MiB，是引擎一次能讀的最大量。1 MB 的檔案大約 2 秒開好。
- lint 在存檔時跑，不會邊打邊跑。目前沒有自動補全。
- Cmd+Z 留給 Ghostty，它用來重開關掉的分頁。Claude Code 會先攔走 Ctrl+Z、Ctrl+D、Ctrl+C，所以復原用 Option+Z。

## 其他

給 AI agent 的結構化資訊與開發說明在[英文版](README.md#for-ai-agents)。

## 授權

[MIT](LICENSE)
