# wb2dsh

Import **WorkBuddy** (CN / International) and **Claude Code** chat history into a
**DeepSeek Harness (DSH)** session library — as **native v4 sessions** that DSH
opens and renders directly.

把 **WorkBuddy**（CN / 国际版）与 **Claude Code** 的聊天记录导入 **DeepSeek Harness (DSH)**
会话库，生成 DSH **原生 v4 会话**：列表可见、点开即显示完整对话。

Zero dependencies · Node.js only · MIT
零依赖 · 只需 Node.js · MIT

**语言 / Language:** [中文](#中文) · [English](#english)

---

## 中文

### 简介

`wb2dsh` 把不同 Agent 工具里"聊天流水账"式的历史，翻译成 DSH 的"只追加事件日志"，
从而在 DSH 里像原生会话一样浏览、回放。

支持来源（三者同源，都是 Claude-Code 系 JSONL）：

- WorkBuddy：`~/.workbuddy/projects`
- WorkBuddy AI（国际版）：`~/.workbuddy-ai/projects`
- Claude Code：`~/.claude/projects`

### 原理

WorkBuddy / Claude Code / DSH 都以"每行一个 JSON"记录对话，但结构不同：

- **WorkBuddy / Claude Code**：按项目文件夹存放，一行一条记录（用户消息 / 助手消息 /
  一次工具调用 / 一次工具结果），像聊天流水账。
- **DSH**：每个会话是一份**只追加的事件日志**（v4），zstd 压缩，放在由
  「工作目录 + 会话 ID」算出的固定路径下；**界面里的对话是从这份日志"折叠"出来的**。

工具分四步翻译：

1. **读取**：扫描各来源 `*.jsonl`，逐行还原出真实工作目录（cwd）、标题、以及
   "用户 / 助手 / 工具调用 / 工具结果"的顺序内容。
2. **归并**：同侧连续片段合成"一条消息"，再把"用户消息 + 随后助手回复"配成一**轮**。
3. **生成**：写出 DSH 事件——会话头 → 权限/沙箱/模型前置 → 每一轮
   （`turn/start → user/message → step/start → assistant/message → step/end → turn/end`）
   → 会话标题。工具调用/结果转成可读文字块，保证干净渲染。
4. **落盘 + 登记**：压成**多帧 zstd**（第 0 帧只放一行会话头，后续帧放事件），写入
   `<dsh>/sessions/<projectKey(cwd)>/session-<id>/session.v4.jsonl.zstd`，并在
   `<dsh>/storages/workspace.json` 登记「工作区 → 会话」。

> 路径命名、分帧、`surfaceOp`、`turn/end reason` 等细节由工具自动处理，你无需手动修改。

**为什么能放心重跑**：目标会话 ID 是**确定性**算出的（来源 + 原文件 ID + 工作目录），
同一源永远落到同一目标文件，已存在就跳过；导入前自动备份 `.dsh`。

### 从零上手教程（WorkBuddy → DSH）

**0. 准备**：Node.js **≥ 22.15**（`node -v` 确认）；本机有 WorkBuddy 历史；已安装 DSH（默认 `~/.dsh`）。

**1. 拿到项目**：把 `dsh-history-importer` 放到任意目录，**无需 `npm install`**（零依赖）。

**2. 关掉 DSH**：关闭运行 DSH 的黑色命令行窗口（`dsh-web.bat`）。工具会自检，检测到在跑会拒绝执行。

**3. 先预演（建议）**：

```bash
node bin/wb2dsh.mjs --dry-run
```

打印来源、会话数、将创建的工作区数——**不写任何东西**。

**4. 正式导入**：

```bash
node bin/wb2dsh.mjs
```

自动：备份 `.dsh` → 写入会话 → 登记工作区 → 打印汇总（scan / written / skipped / failed / workspaces）。

**5. 重开 DSH 看效果**：双击 `dsh-web.bat`，浏览器打开 `http://localhost:3080`，
左侧出现工作区与会话，点开即完整对话。

**6. 常用参数**

| 场景 | 命令 |
|---|---|
| DSH 不在默认位置 | `--dsh-home "D:/my/.dsh"` |
| 只导 Claude Code 历史 | `--sources "claude-code:C:/Users/你/.claude/projects"` |
| 指定模型标识 | `--provider makie --model global:deepseek-v4.1-flash` |
| 不想自动备份 | `--no-backup` |
| DSH 停不下来硬写 | `--force`（写完仍需重启 DSH 才可见） |

**7. 出问题**

| 现象 | 处理 |
|---|---|
| 提示 "DSH appears to be running" | 先关 DSH，或加 `--force` |
| 数字对不上 | `--dry-run` 看哪个来源缺失，确认目录存在 |
| 导入后没变化 | 确认**重启了** DSH（它只在启动时读 `workspace.json`） |
| 想撤回 | 从 `.dsh/backups/wb2dsh-*/` 恢复 `sessions` 与 `storages` |

### 命令行选项

| 选项 | 说明 |
|---|---|
| `--dsh-home <dir>` | DSH 配置目录（默认 `~/.dsh`） |
| `--sources <list>` | `id:dir` 逗号分隔，默认三家来源 |
| `--provider <id>` / `--model <id>` | 记录到日志里的模型标识 |
| `--dry-run` | 只扫描，不写任何东西 |
| `--no-backup` | 跳过自动备份 |
| `--force` | DSH 在跑时仍继续 |
| `--list-sources` | 打印解析到的来源目录 |
| `--help` / `--version` | 帮助 / 版本 |

### 安全性

- 幂等：重跑只补缺失，不重复、不覆盖。
- 导入前自动备份 `.dsh`（`sessions` + `storages`）。
- 不修改任何源文件，只往 DSH 库里新增。
- 检测到 DSH 运行时会拒绝（除非 `--force`）。

### 目录结构

```
bin/wb2dsh.mjs        CLI 入口
lib/format.mjs        DSH v4 会话构建（事件流、projectKey、多帧 zstd）
lib/parse.mjs         WorkBuddy + Claude Code JSONL 解析
lib/workspace.mjs     workspace.json 登记 + 备份 / 运行检测
docs/FORMAT.md        产出的 DSH 会话格式规范
docs/GETTING-STARTED.md  原理与上手教程
README.md
package.json          零依赖，Node ≥ 22.15，MIT
```

---

## English

### Overview

`wb2dsh` translates the "chat transcript" history used by other agent tools into
DSH's append-only **event log**, so the imported sessions behave like native DSH
sessions — they appear in the sidebar, open, and render the full conversation.

Supported sources (all share the Claude-Code JSONL lineage):

- WorkBuddy: `~/.workbuddy/projects`
- WorkBuddy AI (International): `~/.workbuddy-ai/projects`
- Claude Code: `~/.claude/projects`

### How it works

WorkBuddy / Claude Code / DSH all record conversations as "one JSON per line",
but with different structures:

- **WorkBuddy / Claude Code**: one file per project folder, one record per line
  (user message / assistant message / tool call / tool result) — a chat transcript.
- **DSH**: each session is an **append-only event log** (v4), zstd-compressed, at a
  path derived from *working directory + session id*; **the UI's conversation view
  is folded from this log**.

The tool translates in four steps:

1. **Read** every source `*.jsonl`, recovering the real working directory (`cwd`),
   title, and the ordered content (user / assistant / tool call / tool result).
2. **Merge** consecutive same-side pieces into one message, then pair
   "user message + following assistant reply" into one **turn**.
3. **Build** DSH events — session header → permission/sandbox/model preamble → each
   turn (`turn/start → user/message → step/start → assistant/message → step/end → turn/end`)
   → session title. Tool calls/results become readable text blocks so the
   conversation renders cleanly.
4. **Store + register**: compress into **multi-frame zstd** (frame 0 = the header
   line, later frames = events), write to
   `<dsh>/sessions/<projectKey(cwd)>/session-<id>/session.v4.jsonl.zstd`, and
   register "workspace → session" in `<dsh>/storages/workspace.json`.

> Path naming, framing, `surfaceOp`, `turn/end reason` and other details are handled
> automatically — you never edit them by hand.

**Why re-running is safe**: target session ids are **deterministic** (derived from
source + original file id + working directory), so a given source session always
maps to the same target file and is skipped if present. `.dsh` is backed up first.

### Getting started (WorkBuddy → DSH)

**0. Prerequisites**: Node.js **≥ 22.15** (`node -v`); local WorkBuddy history;
DSH installed (default `~/.dsh`).

**1. Get the project**: place `dsh-history-importer` anywhere. **No `npm install`**
(zero dependencies).

**2. Stop DSH**: close the console window running DSH (`dsh-web.bat`). The tool also
self-checks and refuses to run while DSH is listening.

**3. Dry run (recommended)**:

```bash
node bin/wb2dsh.mjs --dry-run
```

Prints sources, session count and workspaces to be created — **writes nothing**.

**4. Import**:

```bash
node bin/wb2dsh.mjs
```

It backs up `.dsh`, writes sessions, registers workspaces, and prints a summary
(scan / written / skipped / failed / workspaces).

**5. Reopen DSH**: launch `dsh-web.bat`, open `http://localhost:3080`; your
workspaces and sessions appear on the left — click one to see the full conversation.

**6. Common options**

| Scenario | Command |
|---|---|
| DSH not in the default location | `--dsh-home "D:/my/.dsh"` |
| Import Claude Code history only | `--sources "claude-code:C:/Users/you/.claude/projects"` |
| Set model identity | `--provider makie --model global:deepseek-v4.1-flash` |
| Skip the automatic backup | `--no-backup` |
| Force while DSH is running | `--force` (restart DSH afterwards to see changes) |

**7. Troubleshooting**

| Symptom | Fix |
|---|---|
| "DSH appears to be running" | Stop DSH first, or pass `--force` |
| Counts look wrong | Run `--dry-run`; check the missing source directory exists |
| No change after import | Make sure you **restarted** DSH (it reads `workspace.json` only at startup) |
| Roll back | Restore `sessions` and `storages` from `.dsh/backups/wb2dsh-*/` |

### CLI options

| Option | Description |
|---|---|
| `--dsh-home <dir>` | DSH home (default `~/.dsh`) |
| `--sources <list>` | Comma-separated `id:dir` pairs (default: the three sources above) |
| `--provider <id>` / `--model <id>` | Model identity recorded in the log |
| `--dry-run` | Scan only, write nothing |
| `--no-backup` | Skip the automatic backup |
| `--force` | Proceed even if DSH is running |
| `--list-sources` | Print resolved source roots and exit |
| `--help` / `--version` | Help / version |

### Safety

- Idempotent: re-running only fills gaps; it never duplicates or overwrites.
- Automatic `.dsh` backup (`sessions` + `storages`) before writing.
- Source files are never modified; the import only adds to the DSH library.
- Refuses to run while DSH is listening (unless `--force`).

### Layout

```
bin/wb2dsh.mjs           CLI entry
lib/format.mjs           DSH v4 builder (events, projectKey, multi-frame zstd)
lib/parse.mjs            WorkBuddy + Claude Code JSONL parsers
lib/workspace.mjs        workspace.json registry + backup / running checks
docs/FORMAT.md           on-disk format emitted by this tool
docs/GETTING-STARTED.md  principles and step-by-step guide
README.md
package.json             zero dependencies, Node ≥ 22.15, MIT
```

## License

MIT
