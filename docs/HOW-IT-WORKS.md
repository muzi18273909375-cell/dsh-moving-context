# 它是怎么工作的（源码级）

这里记的是 2026-11 时 DSH 的实际行为，全部有路径行号，方便以后版本变了直接对照。
DSH 安装目录下 `node_modules/@deepseek-ai/` 是各内部包。

## 1. 会话文件长什么样

路径：`~/.dsh/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd`

文件是**多个 zstd 帧首尾拼接**（不是单一帧！），每帧解压后是若干行 JSON：

```
帧1: {"type":"session","version":4,"id":"session-…","cwd":"<工作区路径>",…}\n   ← 恰好一行
帧2: {"type":"…"}\n{"type":"…"}\n…
帧3: …
```

`encodeInitial`（`dsh-session-persistence-jsonl/lib/index.js:3268-3276`）就是 `Buffer.concat([headerFrame, eventFrame])`。

### 第一帧是硬约束

`assertZstdHeaderFrame`（同文件 `:2298`）：

```js
if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1)
  throw new Error("corrupt Zstandard session log: first frame is not exactly one header line");
```

即：第一帧明文非空、**唯一的 `\n` 在末尾**、后面不能再有别的字节。踩中这条的后果特别阴：`listArtifacts`（`:3100-3136`）读不出 header 时执行 `if (metadata === undefined) continue;` —— 会话直接从列表里消失，界面上什么都不报。

### 帧怎么切

`scanZstdFrames`（`:1305-1368`）：

1. magic `28 B5 2F FD`
2. 1 字节 descriptor（FHD）：FCS 标志、single-segment、checksum 标志、dictID 标志
3. single-segment 时没有 window descriptor，否则 1 字节 window descriptor
4. dictID 长度按标志取 0/1/2/4
5. FCS 长度按标志取（single-segment 时 1，否则 0/2/4/8）
6. 循环块：3 字节 header（bit0=last，bit1-2=type，其余=大小）；`payload = type===1 ? 1 : size`（RLE 只占 1 字节）
7. checksum 标志则再跳 4 字节

重压第一帧时用 `zstdCompressAsync(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })`（`:1374`）保持一致。

## 2. 工作区成员关系怎么算

`dsh-workspace/lib/index.js`：

- `:367` `candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id)`
- `:379-396` `[Service.init]()`：**只在启动时** `replaceHeaderIndex(await this.listStoredHeaders())`，然后 `reportFilteredCandidates()`
- `:875-895` `indexHeader`：只有 `realpathNormalize(header.cwd)` 成功且该目录存在才进 `sessionPaths`，否则记 `invalidSessionPaths`
- `:97-103`（编译版 `lib/types/entity.js:52`）`get sessionIds() { return this.record.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path)); }`

推论：**改了 cwd 必须重启**。刷新页面不会重建 `sessionPaths`。

## 3. 侧栏为什么静默丢行

`dsh-client-ui-workspace/lib/client.js:1034-1035`：

```js
const summary = list.byId[id];
if (summary === void 0) continue;
```

`list` 来自宿主 `dsh-api-session-controller/lib/index.js:1959-1989`：

```js
const records = await this.ctx.sessionQuery.listSessions(signal);
for (…)
  const live = this.ctx.sessions.get(record.header.id);
  if (live !== void 0) items.push(this.summaryFor(live));
  else if (record.header.cwd !== void 0) cold.push(record);
```

header 读不出来的会话既不入 `items` 也不入 `cold` —— 于是前端没有 summary，`continue` 掉，一行都不留。客户端**不比对 cwd**，它只信 summary 存不存在。

## 4. projectKey 规则

工程目录名 = `--` + 转义(cwd) + `--`：

- `\`、`/`、`:` 连续段压成一个 `-`
- `[A-Za-z0-9._-]` 原样保留
- 其它码元 → `~` + 大写十六进制、至少 4 位（`padStart(4,'0')`）
- 去掉开头多余 `-`，整体 `slice(0, 251)`

例：`C:\Users\me\Downloads\红利工作台的迭代与维稳。`
→ `--C-Users-me-Downloads-~7EA2~5229~5DE5~4F5C~53F0~7684~8FED~4EE3~4E0E~7EF4~7A33~3002--`

## 5. 数据文件结构

`storages/workspace.json`：

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": { "initialized": true, "defaultWorkspaceId": "…", "workspaceIds": ["…"], "archivedSessionIds": [] },
  "tables": { "workspaces": { "<id>": { "path": "…", "title": "…", "createdAt": "…", "updatedAt": "…", "sessionIds": ["…"] } } }
}
```

`storages/session_projcache/sessions/<id>.json`（缓存，非权威，但要跟 cwd 一致）：

```json
{ "version": 7, "record": { "identity": { "cwd": "…" },
  "rows": { "title": { "val": "…" }, "workingDirectory": { "val": "…" },
            "sessionListMetadata": { "val": { "blank": false, "lastPromptAt": 0 } } } } }
```

注意都在 `record` 下面；`sessionListMetadata.val.blank = true` 的会话会被当成空会话不显示。

## 6. DSH 自带的「搬家」API 是什么

`@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:8664` 的 `Workspace` 接口只有：

```ts
attachSession(sessionId): Promise<void>;
insertSessionBefore(sessionId, beforeSessionId?): Promise<void>;
detachSession(sessionId): Promise<void>;
```

外加 `@deepseek-ai/dsh-api-session-controller/lib/index.js:776` 新建会话时 `await workspace.attachSession(sessionId)`。**没有跨工作区 move**，所以 attach 到别的 path 的工作区也会被 `candidateMatches` 过滤掉——纯 API 搬不成立，必须改 header 的 cwd。
