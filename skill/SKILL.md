---
name: dsh-moving-context
description: "可自由移动工作区内不同工作区内的对话：把 DSH 的一个对话搬到另一个工作区（官方没有这个功能）。用脚本改会话文件里的 cwd、重建 zstd 帧、同步 projcache 与 workspace.json，带备份与三重校验；也能列出所有工作区/会话的归属。"
---

# 可自由移动工作区不同工作区内的对话

DSH 自己只有「把会话挂进工作区」和「工作区内排序」（`Workspace.attachSession` / `insertSessionBefore` / `detachSession`），没有跨工作区搬家，界面上也没有拖拽。这个 skill 就是补这个洞。

脚本：`scripts/move-session.mjs`（自包含，只用 node 内置模块），校验用 `scripts/e2e-check.mjs`（加载 DSH 自己的持久化插件核对）。

## 什么时候用

- 用户说「把这个对话挪到 XX 工作区」「会话跑错工作区了」「默认工作区太乱想分组」。
- 会话在 UI 里消失、想确认它到底落在哪个工作区目录 → 先 `--list`。

## 铁律（照做，别省）

1. **先完全退出 DeepSeek Harness**。工作台在运行时会用内存里的旧状态整份覆盖 `storages/workspace.json`，你会白改。
2. **会话文件第一帧必须解压后恰好只有一行 header（以 `\n` 结尾，后面不能再有第二个字节）**。把整份文件重压成一帧 = DSH 判 `corrupt Zstandard session log: first frame is not exactly one header line` → list 里跳过 → UI 该行被静默丢弃（前端 `if (summary === void 0) continue;`）。
3. 除第一帧外，**其余帧字节原样保留**，只换压缩方式或重写 header 都会破坏可读性。
4. 改完必须**重启**：工作区归属的 header 索引（`sessionPaths`）只在启动时建（`dsh-workspace/lib/index.js:379-396`），刷新页面无效。

## 用法

```powershell
# 看所有工作区 + 每个会话现在归谁、cwd 是什么
node scripts/move-session.mjs --list

# 预览要做什么（不写盘）
node scripts/move-session.mjs --move "修复工作台故障" --to "红利工作台迭代与维稳" --dry

# 真搬（可以一次搬多条，逗号分隔；--move 也接受 sessionId 前缀或标题关键词）
node scripts/move-session.mjs --move session-90d0ddd1,session-60c6acee --to 6dd9307b-a7bf-45aa-9730-f2ba5aeff5a2

# 搬完核对单个会话
node scripts/move-session.mjs --verify session-90d0ddd1

# 用 DSH 自己的插件核对（最硬的证据：formatStatus 必须是 current）
node scripts/e2e-check.mjs C:\Users\clh_0\.dsh\sessions session-90d0ddd1-4a79-48e4-aedc-d8d77c23e10a
```

可选参数：`--home <DSH数据根>`（默认 `~/.dsh`）、`--root <会话根>`、`--workspace-json`、`--projcache`。做演练时用 `--home` 指到临时目录，别碰真数据。

## 脚本做的六件事

1. 定位会话文件 `sessions\<projectKey>\<id>\session.v4.jsonl.zstd`，按 DSH 的 `scanZstdFrames` 算法逐帧切开。
2. 第一帧重压成「单独一行 header + `\n`」，`cwd` 改成目标工作区路径；其余帧原文拼回。
3. 按 `projectKey(newCwd)` 建新工程目录，写新文件；旧会话目录整体 retire 到 `session-move-backup\<时间戳>\`。
4. 改 `storages/session_projcache/sessions/<id>.json`：`record.identity.cwd`、`record.rows.workingDirectory.val`。
5. 改 `storages/workspace.json`：目标工作区 `sessionIds` 前插，其它工作区移除，`updatedAt` 刷新。
6. 读回校验：帧数、第一帧恰好一行、header id 未变、cwd 已改、记录条数逐帧累加。

## 关键路径与细节（下次直接抄，别重新摸）

- 会话根：`C:\Users\clh_0\.dsh\sessions`；工程目录名 = `--` + 转义后的 cwd + `--`，非 `[A-Za-z0-9._-]` 的码元写成 `~XXXX`（大写十六进制、至少 4 位），分隔符和盘符压成一个 `-`。
- `storages/workspace.json` 结构：`{unit:{name,version}, global:{initialized,defaultWorkspaceId,workspaceIds,archivedSessionIds,...}, tables:{workspaces:{<id>:{path,title,createdAt,updatedAt,sessionIds:[...]}}}}`。
- `session_projcache` 结构：`{version:7, record:{identity:{cwd,...}, rows:{title:{val}, workingDirectory:{val}, sessionListMetadata:{val:{blank,lastPromptAt}}, ...}}}`——注意都在 `record` 下面，别写错层。
- 校验源码位置：`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`（`scanZstdFrames`、`assertZstdHeaderFrame`、`projectKey`、`listArtifacts`）；成员过滤在 `@deepseek-ai/dsh-workspace/lib/index.js:367`；前端静默丢弃在 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1034`。
- 帧结构：`28 B5 2F FD` + descriptor（`FHD` 里的 FCS 标志、single-segment、checksum、dictID 各占位）+ 可选 checksum；块循环 `3 字节 header`（bit0=last，bit1-2=type，其余=size；RLE 的 payload 只占 1 字节）。

## 回滚

`session-move-backup\<时间戳>\` 里有：原始会话目录（按旧 projectKey 摆好）、`<id>.projcache.json`、`workspace.json`。把这三样拷回去、重启即可。

## 已实测

- 1343 条记录 / 748 帧的会话，搬出再搬回：帧数、记录数、cwd 全部还原，DSH 自己的 `list()` 两次都判 `formatStatus=current`。
- 24 条记录的小会话同样通过。
- `--home` 指向临时目录的完整演练通过（含 workspace.json 改写与备份生成）。
