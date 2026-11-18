# dsh-moving-context

**可自由移动工作区内的对话。** 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个会话搬到任意另一个工作区 —— 官方没有这个功能（只有 `attachSession` / `detachSession`，没有跨工作区搬家，界面上也没有拖拽）。

A CLI that moves a DeepSeek Harness session between workspaces. DSH itself ships only `attachSession` / `detachSession` / `insertSessionBefore`; there is no cross-workspace move and no drag-and-drop in the UI. This tool fills that gap.

---

## 它到底改了什么

DSH 认为「会话属于某个工作区」要同时满足两件事，两件都要改对：

| 位置 | 内容 | 为什么 |
| --- | --- | --- |
| `sessions/<projectKey>/<id>/session.v4.jsonl.zstd` | 第一帧里的 header `cwd` | `dsh-workspace` 启动时用 header 的 `realpath(cwd)` 建索引；`cwd !== workspace.path` 的会话会被过滤掉，界面那行被静默丢弃 |
| `storages/workspace.json` | 各工作区的 `sessionIds` | 工作区成员表 |
| `storages/session_projcache/sessions/<id>.json` | `record.identity.cwd`、`record.rows.workingDirectory.val` | 侧栏显示的工作目录 |

三个都改了、并且重启 DSH，会话才会真的出现在目标工作区里。

## 两种用法

| 怎么用 | 适合 |
| --- | --- |
| **插件（图形）**：会话行右侧 `⋯` → 「移动此聊天…」→ 选目标工作区 | 平时手动搬，不用关工作台 |
| **命令行 / skill**：`--list` / `--move … --to …` | 批量搬、脚本化、agent 自己调 |

插件装好之后：

```
侧栏 默认工作区
  某个对话        ⋯  ─┬─ 重命名
                       ├─ 移动此聊天…   ← 这里
                       └─ 删除
```

点「移动此聊天…」弹出工作区列表（带每个工作区有多少个对话），选一个就搬。
插件走的是 DSH 自己的成员表（`WorkspaceEntity.attachSession/detachSession`）加索引重建，
**不需要退出工作台**；命令行那半必须退出，因为它直接改 `workspace.json`。

### 装插件

```bash
# 1) 把整个包放进 DSH 的插件目录
xcopy /E /I . "%USERPROFILE%\.dsh\plugins\dsh-moving-context"      # Windows
cp -r . ~/.dsh/plugins/dsh-moving-context                          # macOS / Linux

# 2) 注册进 profile：~/.dsh/profiles/desktop/package.json
#    dependencies 里加  "dsh-moving-context": "link:<上面的绝对路径>"
#    dsh.profile.bundles 里加  "dsh-moving-context"

# 3) 装依赖（在 profile 目录）
cd ~/.dsh/profiles/desktop && pnpm install

# 4) 重启 DeepSeek Harness（客户端插件在启动时加载）
```

插件接口（本地回环，不联网）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/dsh-moving-context/api/list` | 列工作区与各自会话数 |
| `POST` | `/dsh-moving-context/api/move` | `{sessionId, workspaceId}` 搬家，返回帧数/记录数/备份目录 |

正在打开的那个对话拒绝搬（返回 409），先切到别的对话——文件被重写的同时它还在写盘会出事。

## 安装

需要 Node.js ≥ 22.15（用到内置 zstd）。

```bash
git clone https://github.com/USERNAME/dsh-moving-context.git
cd dsh-moving-context
node src/move-session.mjs --help
```

装成命令（可选）：

```bash
npm link          # 之后直接 dsh-moving-context --list
```

作为 DSH skill 用（推荐，agent 可以自己调）：

```bash
# Windows
xcopy /E /I skill "%USERPROFILE%\.dsh\skills\dsh-moving-context"
# macOS / Linux
mkdir -p ~/.dsh/skills/dsh-moving-context && cp -r skill/. ~/.dsh/skills/dsh-moving-context/
# 再把脚本放进去（skill 目录里引用 src/）
mkdir -p ~/.dsh/skills/dsh-moving-context/scripts && cp src/*.mjs ~/.dsh/skills/dsh-moving-context/scripts/
```

## 用法

**先完全退出 DeepSeek Harness。** 它在运行时会用内存里的旧状态整份覆盖 `workspace.json`，你会白改。

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
```

搬完**重启 DSH**。索引只在启动时建，刷新页面无效。

参数：`--home <DSH 数据根>`（默认 `~/.dsh`）、`--root <会话根>`、`--workspace-json`、`--projcache`、`--frames <file>`（帧自检）、`--force`。

## 回滚

每次搬家都会在 `<home>/session-move-backup/<时间戳>/` 留下：

- 原始会话目录（按旧 `projectKey` 摆好，直接拷回去即可）
- `<id>.projcache.json`
- `workspace.json`

把这三样拷回原位、重启，就回到搬之前。

## 三个必须知道的坑

1. **第一帧必须恰好只有一行 header。** DSH 的 `assertZstdHeaderFrame` 要求第一帧解压后「非空，且唯一的换行在末尾」。把整份文件重压成一帧 → `corrupt Zstandard session log: first frame is not exactly one header line` → 会话被 `listArtifacts` 跳过 → 界面看不到，且没有任何报错。
2. **别在 DSH 运行时改。** 它保存工作区状态时是整份覆盖。
3. **`--verify` 通过 ≠ 界面能看到。** 还要 `workspace.json` 的成员关系对、还要重启。三个条件缺一个都不显示，且全程静默。

细节机制（帧格式、projectKey 规则、源码位置）：[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)

## 测试

```bash
npm test
```

在临时目录里造合成数据跑全套（31 项断言）：`--list` 归属识别、`--dry` 不写盘、真搬后文件/成员表/projcache 三方同步、记录数不丢、往返复原、坏文件能被 `--frames` 抓出来、错误输入明确失败且不破坏数据；本机装了 DSH 时还会用它自己的插件复核 `formatStatus=current`。

## 已验证

- 1343 条记录 / 748 帧的真实会话，搬出再搬回：帧数、记录数、cwd 全部还原。
- 24 条记录的小会话同流程通过。
- `--home` 指向临时目录的完整演练通过。
- 搬移后 DSH 自己的 `sessionPersistence.list()` 判 `formatStatus=current`，界面侧栏能看到该会话。

## 卸载

删掉 skill 目录 / `npm unlink` 即可，不会留下后台进程或服务。

## License

MIT
