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

## 7. 搬家为什么要碰三处、顺序是什么

一次搬家（`lib/core.js` 的 `moveSessionFile` + `lib/index.js` 的 `handleMove`）：

1. **读**：`readSessionFile()` 只解码第一帧（`scanZstdFrames(buf, 1)`），校验「第一帧恰好一行」+ header 是可解析 JSON + id 过白名单。
2. **重压第一帧**：`JSON.stringify({...header, cwd: targetPath}) + '\n'` 压成一个独立 zstd 帧（`ZSTD_c_checksumFlag: 1`），**其余帧字节原样拼接**——正文一条记录都不重新编码，所以快、也不会改变记录内容。
3. **原子落盘**：新目录写临时文件 → `fsync` → `rename`。
4. **读回校验**：重新打开新文件，比对 cwd / id / 文件长度；不对就删新目录、抛错，旧目录一直没动。
5. **退休旧目录**：`rename(<旧工程目录>/<id>, <backup>/<时间戳>/<旧工程目录>/<id>)`；失败则删新目录并抛「旧目录进不了备份，已回滚」。
6. **改成员表**：`workspace.json` 里从原工作区 `sessionIds` 移除、往目标 `sessionIds` 插入（原子写，备份留原文）。
7. **改投影缓存**：`session_projcache/sessions/<id>.json` 的 `record.identity.cwd` 与 `record.rows.workingDirectory.val`（原子写）。

插件路径额外走 DSH 自己的 API：`registry.get(sessionId).detachSession()` → `target.attachSession()` →
`registry.replaceHeaderIndex(await workspaceRegistry.listStoredHeaders())`（`dsh-workspace/lib/index.js:865` / `:897`）。
这样不用退出工作台，也不会被内存里的旧表覆盖 —— 前提是 `workspace.json` 里目标工作区的 path 和 header 的新 cwd 完全一致。

## 8. 加固清单（0.3.0）

| 风险 | 处理 |
| --- | --- |
| `sessionId` 拼进 `path.join` 造成路径穿越 | `assertSessionId()` 白名单 `/^session-[A-Za-z0-9._-]{1,100}$/`，核心层与 projcache 层共用 |
| 写到一半崩溃留下半个文件 | `writeFileAtomic()`：临时文件 → `fsync` → `rename` |
| 搬家失败留下两份会话 | 读回校验失败 / 旧目录进不了备份 → 删新目录、旧目录不动、抛可读原因 |
| 截断的 zstd 抛裸 `RangeError` | `scanZstdFrames` 内置 `need(n, what)` 越界检查，错误形如 `truncated zstd frame block header at 42` |
| Windows 大小写差异被当成两个工作区 | `samePath()`：`realpath` + `toLowerCase` 比较 |
| 插件接口 CSRF | 同源检查（`Origin`/`Host`/`Sec-Fetch-Site`）+ 只收 `application/json` + 16 KB 上限 + `nosniff` |
| 同一会话并发搬家 | `inFlight` + 串行队列，重复请求 409，整体 30 s 超时 |
| 插件每次搬家全量扫会话 | `locate()` 先按 owner 工作区的 path 直接拼路径，未命中才回退 `persistence.list()` |

性能（本机 Windows / node 24）：1200 会话 / 6 工作区 `--list` = 352 ms；2.7 MB / 3000 条记录搬家 = 68 ms。
