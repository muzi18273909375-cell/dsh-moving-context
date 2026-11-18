# dsh-moving-context

**可自由移动工作区内的对话。** 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个会话搬到任意另一个工作区 —— 官方没有这个功能（只有 `attachSession` / `detachSession`，没有跨工作区搬家，界面上也没有拖拽）。

A CLI / plugin / skill trio that moves a DeepSeek Harness session between workspaces. DSH itself ships only `attachSession` / `detachSession` / `insertSessionBefore`; there is no cross-workspace move and no drag-and-drop in the UI. This tool fills that gap.

```
侧栏  默认工作区
  某个对话        ⋯  ─┬─ 置顶会话
                       ├─ 重命名
                       ├─ 分叉会话
                       ├─ 移动此聊天…   ← 这个工具加的
                       ├─ 归档会话
                       └─ 复制 Session ID
```

---

## 它到底改了什么

DSH 认为「会话属于某个工作区」要同时满足三件事，三件都要改对：

| 位置 | 内容 | 为什么 |
| --- | --- | --- |
| `sessions/<projectKey>/<id>/session.v4.jsonl.zstd` | 第一帧里的 header `cwd` | `dsh-workspace` 启动时用 header 的 `realpath(cwd)` 建索引；`cwd !== workspace.path` 的会话会被过滤掉，界面那行被静默丢弃 |
| `storages/workspace.json` | 各工作区的 `sessionIds` | 工作区成员表 |
| `storages/session_projcache/sessions/<id>.json` | `record.identity.cwd`、`record.rows.workingDirectory.val` | 侧栏显示的工作目录 |

三个都改了、并且重启 DSH，会话才会真的出现在目标工作区里。

## 两种用法

| 怎么用 | 适合 | 要不要退出工作台 |
| --- | --- | --- |
| **插件（图形）**：会话行右侧 `⋯` → 「移动此聊天…」→ 选目标工作区 | 平时手动搬 | 不用，立刻生效 |
| **命令行 / skill**：`--list` / `--move … --to …` | 批量搬、脚本化、agent 自己调 | 要（它直接改 `workspace.json`） |

插件走 DSH 自己的成员表（`WorkspaceEntity.attachSession/detachSession`）加索引重建；
命令行那半必须退出工作台，因为它直接改 `workspace.json` —— 脚本会自己检测，检测到正在运行就拒绝执行（`--force` 才硬来）。

### 装插件

装法见下面 [安装](#安装)（Windows 与 macOS 分开写）。装完要重启应用；之后客户端半边的改动按一次 `Ctrl+R`（macOS `⌘R`）就热更，不必重启整个应用。

插件接口（本地回环，不联网）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/dsh-moving-context/api/list` | 列工作区与各自会话数；`alive: false` 表示目录已经不在了，界面上会置灰、点不动 |
| `POST` | `/dsh-moving-context/api/move` | `{sessionId, workspaceId}` 搬家，返回帧数/记录数/备份目录 |

会被拒绝的情况（都返回 409 或 400，不会静默改坏数据）：

- 正在打开的那个对话（先切到别的对话——文件被重写的同时它还在写盘会出事）
- 同一个对话同时点两次（第二次返回「这个对话正在搬，稍等」）
- 已经在这个工作区了（no-op，不动文件）
- 请求不是同源、或 `content-type` 不是 `application/json`（防 CSRF）
- 30 秒没搬完（超时退出，原文件不动）

## 安装

Windows 和 macOS 都能装、都能跑。下面的命令两边分开写，照着自己那半边抄就行。

| 平台 | 状态 |
| --- | --- |
| Windows 10 / 11 | 实机验证 + CI（windows-latest，node 22 / 24） |
| macOS（Intel / Apple Silicon） | CI 验证（macos-latest，node 22 / 24） |
| Linux | CI 验证（ubuntu-latest，node 22 / 24） |

### 第 0 步：Node.js ≥ 22.15（内置 zstd，低了直接跑不起来）

```powershell
winget install OpenJS.NodeJS.LTS          # Windows
```
```bash
brew install node                          # macOS（或 nvm install 22 && nvm use 22）
node -v                                    # 两个平台都要 ≥ v22.15
```

### 第 1 步：拿代码

```bash
git clone https://github.com/USERNAME/dsh-moving-context.git
cd dsh-moving-context
node src/move-session.mjs --help           # 能打出帮助就说明 Node 版本够了
```

### 第 2 步：装图形插件（侧栏那个「移动此聊天…」）

**Windows**

```powershell
xcopy /E /I . "%USERPROFILE%\.dsh\plugins\dsh-moving-context"
# 编辑 %USERPROFILE%\.dsh\profiles\desktop\package.json：
#   dependencies 里加       "dsh-moving-context": "link:C:/Users/<你的用户名>/.dsh/plugins/dsh-moving-context"
#   dsh.profile.bundles 里加 "dsh-moving-context"
cd "%USERPROFILE%\.dsh\profiles\desktop"
pnpm install
```

**macOS**

```bash
mkdir -p ~/.dsh/plugins && cp -r . ~/.dsh/plugins/dsh-moving-context
# 编辑 ~/.dsh/profiles/desktop/package.json：
#   dependencies 里加       "dsh-moving-context": "link:/Users/<你的用户名>/.dsh/plugins/dsh-moving-context"
#   dsh.profile.bundles 里加 "dsh-moving-context"
cd ~/.dsh/profiles/desktop && pnpm install
```

两边一样的收尾：**完全退出 DeepSeek Harness 再打开**（macOS 用 `⌘Q`，只关窗口不算退出）。
插件是随应用启动加载的，装完不重启不会出现。

> `link:` 后面写**绝对路径**、用正斜杠；`~` 不会被 pnpm 展开，老老实实写 `/Users/xxx`。

### 第 3 步：装成 skill（agent 能自己调，推荐）

`skill/` 里的脚本是自包含的（已经把 `lib/core.js` 内联进去），拷这一个目录就够：

```powershell
xcopy /E /I skill "%USERPROFILE%\.dsh\skills\dsh-moving-context"                    # Windows
```
```bash
mkdir -p ~/.dsh/skills/dsh-moving-context && cp -r skill/. ~/.dsh/skills/dsh-moving-context/   # macOS
```

### 第 4 步：验证装好了

```bash
node src/move-session.mjs --list            # 能列出工作区和会话就对了
```

界面上：侧栏某个对话右侧 hover 出 `⋯` → 菜单里有「移动此聊天…」。

> 改了 `lib/core.js` 或 `src/move-session.mjs` 之后，跑一次 `npm run build:skill` 重新生成 skill 里的副本；
> `test/skill-bundle.mjs` 会拦住忘了同步的提交。

### macOS 上要多知道两句

- 数据根目录跟 Windows 一样是 `~/.dsh`（`sessions/`、`storages/`、`profiles/`）。
- 临时目录是符号链接：`/var/...` 实际指向 `/private/var/...`。工具内部一律按 `realpath` 比较路径，
  所以中文目录、带空格的目录、符号链接目录都不会被判成两个工作区；自己写脚本调它时也别拿未解析的路径去比。
- 命令行那半的「工作台在跑就拒跑」护栏，在 mac 上认的是 `DeepSeek Harness` 这个进程名（不是 `dsh`）。
- 用 Homebrew 装的 Node 不需要 `sudo`；`npm link` 若报权限错，说明 Node 装在了系统目录，换 nvm 更省事。

### 命令（可选）

```bash
npm link          # 之后直接 dsh-moving-context --list
```


## 用法

**命令行这半：先完全退出 DeepSeek Harness。** 它在运行时会用内存里的旧状态整份覆盖 `workspace.json`，你会白改。
（脚本会检测 `DeepSeek Harness.exe` 进程，检测到就直接报错退出，不会让你误操作。）

```bash
# 1) 看清现状：有哪些工作区、每个会话现在归谁、cwd 是什么、几个帧
node src/move-session.mjs --list

# 2) 预演：只打印计划，一个字节都不写
node src/move-session.mjs --move "检查红利手动更新故障" --to "红利工作台迭代与维稳" --dry

# 3) 真搬（支持一次搬多个，逗号分隔；--move 接受 sessionId、id 前缀或标题关键词）
node src/move-session.mjs --move session-90d0ddd1,session-60c6acee --to 6dd9307b-a7bf-45aa-9730-f2ba5aeff5a2

# 4) 读回校验
node src/move-session.mjs --verify session-90d0ddd1

# 5) 最硬的证据：让 DSH 自己的持久化插件复核
node src/e2e-check.mjs "$HOME/.dsh/sessions" session-90d0ddd1-4a79-48e4-aedc-d8d77c23e10a
#   FOUND session-... formatStatus=current cwd=<新工作区路径>

# 6) 给脚本/agent 用的机器可读输出
node src/move-session.mjs --list --json
```

搬完**重启 DSH**。索引只在启动时建，刷新页面无效。

参数：

| 旗标 | 作用 |
| --- | --- |
| `--home <dir>` | DSH 数据根，默认 `~/.dsh` |
| `--root <dir>` | 会话根，默认 `<home>/sessions` |
| `--workspace-json` / `--projcache` | 单独指定文件位置 |
| `--frames <file>` | 只做帧自检（不搬） |
| `--json` | 输出 JSON（`--list` / `--verify`） |
| `--dry` | 只打印计划 |
| `--force` | 忽略「DSH 正在运行」检测（**危险**：退出时可能被内存旧表覆盖） |

## 回滚

每次搬家都会在 `<home>/session-move-backup/<时间戳>/` 留下：

- 原始会话目录（按旧 `projectKey` 摆好，直接拷回去即可）
- `<id>.projcache.json`
- `workspace.json`

把这三样拷回原位、重启，就回到搬之前。

备份不会自动清理（怕误删你想留的证据）。攒多了手动删 `<home>/session-move-backup/` 下不要的时间戳目录即可。

搬家中途任何一步失败都会自己回滚：新写的目标目录删掉、旧目录原地不动，并且报出可读原因（不会留下「两份会话」这种烂摊子）。

## 六个必须知道的坑

1. **第一帧必须恰好只有一行 header。** DSH 的 `assertZstdHeaderFrame` 要求第一帧解压后「非空，且唯一的换行在末尾」。把整份文件重压成一帧 → `corrupt Zstandard session log: first frame is not exactly one header line` → 会话被 `listArtifacts` 跳过 → 界面看不到，且没有任何报错。
2. **别在 DSH 运行时改 `workspace.json`。** 它保存工作区状态时是整份覆盖。命令行工具会自己检测并拒绝，插件走内存里的成员表所以不受这条限制。
3. **`--verify` 通过 ≠ 界面能看到。** 还要 `workspace.json` 的成员关系对、还要重启。三个条件缺一个都不显示，且全程静默。
4. **往 `kind: "list"` 的 slot 注册时必须给 `id`。** `ctx.slots.register({ name, id }, Component)` 少了 `id`，客户端直接抛 `list slot "sidebar.workspaces.session.menu.item" requires options.id`，插件其余部分照常加载、界面里就是少一条菜单，只有开发者工具的 Console 里看得到。客户端半边的改动按一次 `Ctrl+R` 就重新加载，不必重启整个应用。
5. **工作区路径结尾有全角字符时别手抄。** Windows 上确实存在 `红利工作台的迭代与维稳。`（结尾是 U+3002）这种目录，路径比较一律走 `realpath` + 大小写归一，差一个字符都会被判成两个工作区。
6. **macOS / Linux 上路径一律按真实路径算。** 临时目录 `/var/...` 实际是 `/private/var/...` 的软链接、Windows 的目录联接也一样：同一个目录能算出两个 `projectKey`。工具内部会同时试「登记路径」和「realpath」两种 key，自己写脚本调它时也别拿未解析的路径去比。

细节机制（帧格式、projectKey 规则、源码位置）：[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)
版本与加固记录：[CHANGELOG.md](CHANGELOG.md)

## 安全 / 稳健性设计

对「别人拿到这个工具去跑」的场景做过针对性加固：

- **会话 id 白名单**：`/^session-[A-Za-z0-9._-]{1,100}$/`，`../`、斜杠、对象、空值一律拒绝（projcache 也是拼路径的，所以同一条规则管两处）。
- **写入原子化**：先写临时文件 → `fsync` → `rename` 覆盖，断电/崩溃不会留下半个文件。
- **失败回滚**：新文件读回校验（cwd / id / 长度）不通过，或旧目录进不了备份，都会把新目录删掉、旧目录留在原地，然后报错。
- **CSRF 面**：插件接口只认同源请求（`Origin` 与 `Host` 一致、`Sec-Fetch-Site: same-origin|none`）、只收 `application/json`、请求体上限 16 KB，响应带 `nosniff`。
- **并发**：同一个会话的搬家串行化，重复请求拿 409；整体 30 秒超时。
- **坏文件**：截断的帧报 `truncated zstd frame … at N`，空文件报 `empty session log`，都不是裸 `RangeError`。

## 性能（本机实测，Windows / node 24）

| 场景 | 结果 |
| --- | --- |
| `--list` 扫 6 个工作区 / 1200 个会话 | 352 ms（一次读盘建索引，不重复解码） |
| 搬一个 2.7 MB、3000 条记录的会话 | 68 ms（只重压第一帧，正文帧原样搬运） |
| 搬到别的 1200 会话的库里 | 正常，成员表与 projcache 同步更新 |

## 测试

```bash
npm test            # 全套 68 项
npm run test:scale  # 只跑规模 / 回滚 / 坏文件那 12 项
npm run build:skill # 重新生成 skill 里的自包含脚本
```

在临时目录里造合成数据跑全套（68 项断言），不碰你真实的 `~/.dsh`：

| 套件 | 项数 | 覆盖 |
| --- | --- | --- |
| `test/run-tests.mjs` | 31 | `--list` 归属识别、`--dry` 不写盘、真搬后文件/成员表/projcache 三方同步、记录数不丢、往返复原、错误输入明确失败且不破坏数据 |
| `test/host-core.mjs` | 7 | 插件宿主层：搬家前后成员表与帧头、拒绝正打开的会话、幂等 |
| `test/client-smoke.mjs` | 5 | 客户端半边：假的 `__ModuleLoader__` + 假 DOM 渲染菜单项，槽位注册必须带 `id` |
| `test/handle-move.mjs` | 10 | 插件请求层：同源/JSON 校验、非法 id、正常搬家、幂等、成员表失败回滚、目标不存在、并发 409 |
| `test/skill-bundle.mjs` | 3 | skill 里的自包含脚本与源码一致（防漂移） |
| `test/hardening.mjs` | 12 | id 穿越、projcache 穿越、回滚、目标异常、坏文件、幂等、1200 会话规模、2.7 MB 大会话 |

本机装了 DSH 时，`src/e2e-check.mjs` 还会用 DSH 自己的持久化插件复核 `formatStatus=current`（没装就打印 SKIP 并 0 退出，CI 里也能跑）。

## 已验证

- 1343 条记录 / 748 帧的真实会话，搬出再搬回：帧数、记录数、cwd 全部还原。
- 24 条记录的小会话同流程通过。
- 在两个真实工作区之间用界面上的「移动此聊天…」搬过，侧栏立刻变成目标工作区的那一行，不需要重启。
- `--home` 指向临时目录的完整演练通过；1200 会话 / 6 工作区的规模测试通过。
- 搬移后 DSH 自己的 `sessionPersistence.list()` 判 `formatStatus=current`。
- Windows（实机）与 macOS / Ubuntu（GitHub Actions，node 22 / 24）三平台六任务全绿；
  macOS 的 `/var → /private/var` 软链接场景用 Windows 目录联接复现过，六套 68 项同样全过。

## 卸载

删掉插件目录（并从 profile 的 `dependencies` / `bundles` 里去掉）、删掉 skill 目录 / `npm unlink` 即可，不会留下后台进程或服务。

## License

MIT
