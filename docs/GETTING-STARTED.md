# 原理与上手教程

## 一、原理（一句话版）

**把「聊天记录」翻译成「DSH 能读的事件日志」。**

WorkBuddy、Claude Code、DSH 三者都（大致）以"每行一个 JSON 的 JSONL"记录对话，但**结构不同**：

- **WorkBuddy / Claude Code**：按项目文件夹存放，每条记录是一行 JSON ——
  可能是"用户消息""助手消息""一次工具调用""一次工具结果"。它更像"聊天流水账"。
- **DSH**：每个会话是一份**只追加的事件日志**（v4），用 zstd 压缩，放在由
  "工作目录 + 会话 ID"算出来的特定路径下；**界面的对话视图是从这份日志"折叠"出来的**。

`wb2dsh` 就是这三步的翻译器：

```
读取源 JSONL  →  归并成"轮次"  →  生成 DSH v4 事件日志  →  压缩落盘 + 登记工作区
```

1. **读取**：扫描 `~/.workbuddy/projects`、`~/.workbuddy-ai/projects`、
   `~/.claude/projects` 下的每个 `*.jsonl`，逐行解析，恢复出：真实工作目录（cwd）、
   标题、以及按"用户 / 助手 / 工具调用 / 工具结果"排列的内容。
2. **归并**：把同一侧的连续片段合成"一条消息"，再把"用户消息 + 随后的助手回复"
   配成一轮（turn）。
3. **生成**：为每个会话写出一串 DSH 认得的事件——
   会话头 → 权限/沙箱/模型等前置 → 每一轮（`turn/start → user/message →
   step/start → assistant/message → step/end → turn/end`）→ 会话标题。
   工具调用/结果会转成可读文字块，保证对话能干净渲染。
4. **落盘 + 登记**：
   - 压缩成 **多帧 zstd**（第 0 帧只放一行"会话头"，后续帧放事件），
     存到 `<dsh>/sessions/<projectKey(cwd)>/session-<id>/session.v4.jsonl.zstd`；
   - 在 `<dsh>/storages/workspace.json` 里登记"工作区 → 会话"。

> 这些路径名、分帧、`surfaceOp`、`turn/end reason` 等细节都由工具自动处理，
> 你不需要手动碰。它们的存在只为一件事：**让 DSH 的列表能列出、点开能看到完整对话。**

### 为什么能安全重复跑
每个目标会话的 ID 是**确定性**算出来的（由"来源 + 原文件 ID + 工作目录"派生），
所以同一个源会话永远落到同一个目标文件；文件已存在就跳过——**重跑不会重复、不会破坏已有数据**。
导入前还会自动把 `.dsh` 的 `sessions` 和 `storages` 备份一份。

---

## 二、从零上手教程（WorkBuddy → DSH）

### 0. 准备
- 已安装 **Node.js ≥ 22.15**（`node -v` 确认）。
- 本机有 WorkBuddy/Claude Code 的聊天记录（默认就在 `~/.workbuddy`、`~/.claude`）。
- 已安装 **DSH**，其配置目录默认是 `~/.dsh`。

### 1. 拿到项目
把 `dsh-history-importer` 目录放到任意位置即可，**无需 `npm install`**（零依赖）。

### 2. 关掉正在运行的 DSH
DSH 运行时会把内存里的状态写回 `workspace.json`，会覆盖导入结果。
- Windows：关掉启动 DSH 的那个黑色命令行窗口（`dsh-web.bat`）。
- 确认 3080 端口没被占用（工具也会自己检测，检测到在跑会拒绝执行）。

### 3. 先预演（强烈建议）
```bash
node bin/wb2dsh.mjs --dry-run
```
会打印：识别到的来源、会话总数、将创建的工作区数。**不写任何东西**，先心里有数。

### 4. 正式导入
```bash
node bin/wb2dsh.mjs
```
它会：备份 `.dsh` → 写入所有会话 → 登记工作区 → 打印汇总
（scan / written / skipped / failed / workspaces）。

### 5. 重开 DSH 看效果
- 双击 `dsh-web.bat`；
- 浏览器打开 `http://localhost:3080`；
- 左侧会出现你的工作区和会话，点开任意一个即可看到**完整对话**。

### 6. 常用参数
| 场景 | 命令 |
|---|---|
| DSH 不在默认位置 | `node bin/wb2dsh.mjs --dsh-home "D:/my/.dsh"` |
| 只想导 Claude Code 历史 | `node bin/wb2dsh.mjs --sources "claude-code:C:/Users/你/.claude/projects"` |
| 指定模型标识 | `node bin/wb2dsh.mjs --provider makie --model global:deepseek-v4.1-flash` |
| 不想自动备份 | `node bin/wb2dsh.mjs --no-backup` |
| DSH 暂时停不下来，硬写 | `node bin/wb2dsh.mjs --force`（写完仍需重启 DSH 才看得到） |

### 7. 出问题怎么办
| 现象 | 处理 |
|---|---|
| 提示"DSH appears to be running" | 先关掉 DSH 再跑，或加 `--force` |
| 数字对不上 | 用 `--dry-run` 看是哪个来源缺失；确认对应目录存在 |
| 导入后没变化 | 确认导入后**重启了** DSH（它只在启动时读 `workspace.json`） |
| 想撤回 | 从 `.dsh/backups/wb2dsh-*/` 恢复 `sessions` 和 `storages` 即可 |
