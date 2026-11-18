# Changelog

## 0.3.0 — 上传 GitHub 前的加固

### 安全

- 会话 id 白名单：`/^session-[A-Za-z0-9._-]{1,100}$/`。`../`、`/`、`\`、空值、非字符串在 `assertSessionId()` 就被拒，
  `session_projcache` 的路径拼接共用这条规则（之前 `sessionId` 直接进 `path.join`）。
- 插件接口只认同源请求：`Origin` 必须与 `Host` 一致、`Sec-Fetch-Site` 只能是 `same-origin` / `none`、
  `content-type` 必须是 `application/json`（否则 415）、请求体上限 16 KB、响应加 `x-content-type-options: nosniff`。
- 响应写入前检查 `res.headersSent || res.writableEnded`，异常不会二次写头。

### 稳健性

- 所有落盘改成「临时文件 → fsync → rename」原子写（`writeFileAtomic`）。
- 搬家失败自动回滚：新文件读回校验（cwd / id / 文件长度）失败 → 删新目录、旧目录不动；
  旧目录 rename 进备份失败 → 删新目录并抛「旧目录进不了备份，已回滚」。不再可能留下两份会话。
- 目标工作区不存在 / 指向文件 → 明确报错，源文件不动。
- 截断的 zstd 帧报 `truncated zstd frame <what> at <offset>`，空文件报 `empty session log`（之前是裸 `RangeError`）。
- 同路径比较走 `realpath` + Windows 大小写归一，`C:\A` 与 `c:\a` 不再被当成两个工作区。
- 同一会话的搬家串行化（`inFlight` + 队列），重复点击返回 409；整体 30 秒超时。
- 已经在目标工作区再搬一次是 no-op（`unchanged: true`），文件字节不变。

### 性能

- `--list` / `move` 改成「一次读盘建索引」（`buildIndex`），不再对每个会话重复解码两遍；
  1200 会话 / 6 工作区 `--list` = 352 ms。
- 搬家只重压第一帧，正文帧原样 byte-copy；2.7 MB / 3000 条记录搬家 68 ms。
- 插件宿主层 `locate()` 先走 `registry.list()` 的快路拼路径，命中就不去 `persistence.list()` 全量扫。

### 体验

- 命令行新增「DSH 正在运行就拒绝执行」的检测（`tasklist` / `pgrep`），并提示根本原因；`--force` 才越过。
- 新增 `--json`（`--list` / `--verify`），给脚本和 agent 用。
- `findWorkspace` 改成 id → 精确标题 → 精确路径 → 唯一模糊，多义时列出候选并报错。
- skill 里的脚本改为由 `scripts/build-skill.mjs` 从源码生成（自包含，只拷 `skill/` 就够），
  `test/skill-bundle.mjs` + CI 拦住漂移。

### 测试

- 新增 `test/handle-move.mjs`（9 项）：在假宿主上跑完整请求流程，含「成员表 attach 失败 → 文件搬回原工作区并重新挂回原工作区」的回滚回归测试。
- 新增 `test/hardening.mjs`（12 项）、`test/skill-bundle.mjs`（3 项），全套 68 项断言全绿。
- CI 增加 `scripts/build-skill.mjs --check` 与新增文件的 `node --check`。

## 0.2.1

- **修**：客户端插件往 `kind: "list"` 的 slot 注册时漏了 `id`，导致
  `Uncaught Error: list slot "sidebar.workspaces.session.menu.item" requires options.id`，
  菜单里看不到「移动此聊天…」。客户端半边改完 `Ctrl+R` 即生效，不必重启整个应用。
- 测试：`test/client-smoke.mjs` 的假槽位改成按真实规则校验（缺 `id` 直接抛）。

## 0.2.0

- 新增 DSH 客户端插件：会话行 `⋯` → 「移动此聊天…」→ 选目标工作区，走 `attachSession` / `detachSession` +
  索引重建，不用退出工作台。
- 新增插件宿主半边：`GET /dsh-moving-context/api/list`、`POST /dsh-moving-context/api/move`。
- 新增 `test/host-core.mjs`、`test/client-smoke.mjs`。

## 0.1.0

- 首个版本：命令行把会话在 DSH 工作区之间搬家（重写 zstd 第一帧 header 的 `cwd`、同步 `workspace.json`
  的 `sessionIds`、同步 `session_projcache`），带备份与读回校验。
- `src/e2e-check.mjs`：用 DSH 自己的持久化插件复核 `formatStatus=current`。
