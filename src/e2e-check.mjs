#!/usr/bin/env node
/**
 * e2e-check.mjs — 用 DeepSeek Harness 自己的持久化插件核对会话文件是不是真的能被它读出来。
 *
 * 这一步的意义：搬完之后「我自己解析得动」不算数，得让 DSH 自己的 list() 认。
 * 只有 formatStatus=current 才算搬成功。
 *
 * 用法：
 *   node e2e-check.mjs <sessions根目录> [sessionId...]
 *
 * 找 DSH 安装目录的顺序：
 *   1. 环境变量 DSH_APP_DIR（指向 .../resources/app/dsh）
 *   2. Windows: %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app\dsh
 *   3. 常见备选路径（macOS / Linux / 自定义安装）
 * 找不到就跳过（退出码 0，打印 SKIP），不阻塞 CI。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.DSH_APP_DIR,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources', 'app', 'dsh'),
  '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh',
  path.join(os.homedir(), '.local', 'share', 'deepseek-harness', 'app', 'dsh'),
].filter(Boolean);

function findAppDir() {
  for (const dir of CANDIDATES) {
    if (dir && fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js'))) {
      return dir;
    }
  }
  return undefined;
}

const appDir = findAppDir();
if (appDir === undefined) {
  console.log('SKIP：没找到 DeepSeek Harness 安装目录（可用 DSH_APP_DIR 指定）');
  process.exit(0);
}

const root = process.argv[2];
const ids = process.argv.slice(3);
if (root === undefined) {
  console.error('用法: node e2e-check.mjs <sessions根目录> [sessionId...]');
  process.exit(2);
}

const BASE = pathToFileURL(path.join(appDir, 'node_modules')).href + '/';
const cordis = await import(BASE + '@deepseek-ai/cordis/lib/index.js');
const plugin = await import(BASE + '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');

const ctx = new cordis.Context();
await ctx.plugin(plugin, { root });

const service = await (async () => {
  for (let i = 0; i < 400; i++) {
    const svc = ctx.get('sessionPersistence');
    if (svc !== undefined) return svc;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('sessionPersistence 没有在 20 秒内注册');
})();

const artifacts = await service.list();
console.log(`DSH 自己读出 ${artifacts.length} 条会话（root=${root}）`);

let bad = 0;
for (const id of ids) {
  const hit = artifacts.find((a) => a.header?.id === id);
  if (hit === undefined) {
    console.log(`  MISSING ${id}（DSH 没读到这条）`);
    bad++;
    continue;
  }
  console.log(`  FOUND ${id} formatStatus=${hit.formatStatus} cwd=${hit.header.cwd}`);
  if (hit.formatStatus !== 'current') bad++;
}
process.exit(bad === 0 ? 0 : 1);
