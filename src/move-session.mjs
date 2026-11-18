#!/usr/bin/env node
/**
 * move-session.mjs — 把 DSH 会话在「工作区」之间搬家（官方没有这个功能）。
 *
 * 用法（**先完全退出 DeepSeek Harness**，脚本会自己检查）：
 *   node move-session.mjs --list [--json]
 *   node move-session.mjs --move <sessionId|标题关键词> --to <工作区标题|工作区id|路径> [--dry] [--force]
 *   node move-session.mjs --verify <sessionId>
 *   node move-session.mjs --frames <file>
 *
 * 可选：--home <DSH 数据根>   默认 ~/.dsh
 *       --root <会话根>       默认 <home>/sessions
 *       --workspace-json <file> / --projcache <dir>   演练或迁移时指到别处
 *
 * 它做的事（每一步都可回滚，备份统一放在 <home>/session-move-backup/<时间戳>/）：
 *   1. 定位会话文件，逐个 zstd 帧切开（照抄 DSH 的 scanZstdFrames）
 *   2. 第一帧重压成「单独一行 header + \n」，cwd 改成目标工作区路径；其余帧字节不动
 *   3. 按 DSH 的 projectKey 规则把文件放到新的工程目录，旧目录 retire 到备份
 *   4. 修正 session_projcache 里的 identity.cwd / rows.workingDirectory.val
 *   5. 改 workspace.json：目标工作区 sessionIds 加进去，其它工作区移除
 *   6. 读回校验：帧结构、第一帧单行、cwd、记录数
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  assertSessionId,
  countRecords,
  decodeFrame,
  encodeSegment,
  firstLine,
  isLogName,
  LOG_NAME,
  moveSessionFile,
  projectKey,
  readSessionFile,
  scanZstdFrames,
  updateProjcache,
} from '../lib/core.js';

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const flag = (name) => argv.includes('--' + name);

const HOME = String(opt('home', path.join(os.homedir(), '.dsh')));
const ROOT = String(opt('root', path.join(HOME, 'sessions')));
const WS_JSON = String(opt('workspace-json', path.join(HOME, 'storages', 'workspace.json')));
const PROJCACHE_DIR = String(opt('projcache', path.join(HOME, 'storages', 'session_projcache', 'sessions')));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = path.join(HOME, 'session-move-backup', STAMP);
const DRY = flag('dry');
const FORCE = flag('force');
const JSON_OUT = flag('json');

// ---------------------------------------------------------------- 运行中的 DSH
const APP_IMAGE = 'DeepSeek Harness.exe';
// macOS 上 Electron 进程的名字是「DeepSeek Harness」（带空格），没有 dsh 字样，
// 所以 POSIX 要按平台各试一遍，任一命中就算在工作台在跑。
const POSIX_APP_PATTERNS =
  process.platform === 'darwin' ? ['DeepSeek Harness', 'dsh'] : ['dsh'];

function runningDsh() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
      return out.includes(APP_IMAGE) ? APP_IMAGE : undefined;
    }
    for (const pattern of POSIX_APP_PATTERNS) {
      let out;
      try {
        out = execFileSync('pgrep', ['-fl', pattern], { encoding: 'utf8', timeout: 8000 });
      } catch {
        continue; // pgrep 没命中时退出码非零
      }
      const hit = out
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !/move-session|dsh-moving-context/.test(line));
      if (hit !== undefined) return hit;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 扫描
function listSessionDirs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(root, proj.name);
    let entries;
    try {
      entries = fs.readdirSync(projPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ses of entries) {
      if (!ses.isDirectory()) continue;
      const dir = path.join(projPath, ses.name);
      let files;
      try {
        files = fs.readdirSync(dir).filter(isLogName);
      } catch {
        continue;
      }
      for (const f of files) out.push({ projectKey: proj.name, dir, file: path.join(dir, f) });
    }
  }
  return out;
}

/** 一次读盘建索引：header 只解析一遍，坏文件记下来不中断 */
function buildIndex(root) {
  const items = [];
  const broken = [];
  for (const s of listSessionDirs(root)) {
    try {
      const { header, frame1 } = readSessionFile(s.file);
      items.push({ ...s, id: header.id, cwd: header.cwd, headerBytes: frame1.length });
    } catch (error) {
      broken.push({ ...s, error: error.message });
    }
  }
  return { items, broken };
}

function titleOf(id) {
  const p = path.join(PROJCACHE_DIR, id + '.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rec = j?.record ?? j;
    return rec?.rows?.title?.val ?? rec?.title ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 工作区
function loadWorkspaceJson() {
  const raw = fs.readFileSync(WS_JSON, 'utf8');
  return { text: raw, data: JSON.parse(raw) };
}

function workspaces(data) {
  const table = data?.tables?.workspaces ?? {};
  return Object.entries(table).map(([id, w]) => ({ id, ...w }));
}

function findWorkspace(data, needle) {
  const all = workspaces(data);
  const raw = String(needle);
  const lower = raw.toLowerCase();
  const byId = all.find((w) => w.id === raw);
  if (byId) return byId;

  const byExact = all.filter((w) => String(w.title ?? '').toLowerCase() === lower);
  if (byExact.length === 1) return byExact[0];

  const byPath = all.filter((w) => String(w.path ?? '').toLowerCase() === lower);
  if (byPath.length === 1) return byPath[0];

  const byFuzzy = all.filter(
    (w) => String(w.title ?? '').toLowerCase().includes(lower) || String(w.path ?? '').toLowerCase().includes(lower),
  );
  if (byFuzzy.length === 1) return byFuzzy[0];
  if (byFuzzy.length > 1) {
    throw new Error(
      `工作区名字太模糊，命中了 ${byFuzzy.length} 个：\n` +
        byFuzzy.map((w) => `  - ${w.title} [${w.id}] ${w.path}`).join('\n') +
        '\n请用完整标题或 id 指定。',
    );
  }
  return undefined;
}

function guardRunning() {
  const proc = runningDsh();
  if (proc === undefined) return;
  if (FORCE) {
    console.warn(`⚠ 检测到 DSH 正在运行（${proc}），--force 已忽略该检查。`);
    console.warn('  运行中改 workspace.json，退出时会被内存里的旧表覆盖 —— 除非你知道自己在做什么。');
    return;
  }
  throw new Error(
    `DeepSeek Harness 还在运行（${proc}）。\n` +
      '它退出时会把内存里的工作区表整份写回，运行中搬的会话会被抹掉。\n' +
      '先完全退出工作台（托盘也要退），再跑这个命令；确认无妨可以加 --force。',
  );
}

// ---------------------------------------------------------------- 命令：list
function cmdList() {
  const { data } = loadWorkspaceJson();
  const { items, broken } = buildIndex(ROOT);

  if (JSON_OUT) {
    const payload = {
      home: HOME,
      workspaces: workspaces(data).map((w) => ({
        id: w.id,
        title: w.title,
        path: w.path,
        sessions: (w.sessionIds ?? []).length,
      })),
      sessions: items.map((s) => {
        const owner = workspaces(data)
          .filter((w) => (w.sessionIds ?? []).includes(s.id))
          .map((w) => w.title);
        return {
          id: s.id,
          title: titleOf(s.id),
          cwd: s.cwd,
          file: s.file,
          workspaces: owner,
        };
      }),
      broken: broken.map((b) => ({ dir: b.dir, error: b.error })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`工作区（${WS_JSON}）`);
  for (const w of workspaces(data)) {
    console.log(`  [${w.id}] ${w.title}\n      path=${w.path}\n      sessions=${(w.sessionIds ?? []).length}`);
  }

  console.log(`\n磁盘上的会话（${items.length} 个）`);
  for (const s of items) {
    const owner = workspaces(data)
      .filter((w) => (w.sessionIds ?? []).includes(s.id))
      .map((w) => w.title);
    console.log(
      `  ${s.id}\n      title=${titleOf(s.id) ?? '-'}\n      cwd=${s.cwd}\n` +
        `      workspace=${owner.length ? owner.join(' / ') : '(未登记)'}\n      headerBytes=${s.headerBytes}`,
    );
  }
  if (broken.length > 0) {
    console.log(`\n读不出 header 的（${broken.length} 个，DSH 也会跳过它们）`);
    for (const b of broken) console.log(`  ${b.dir}\n      ${b.error}`);
  }
}

// ---------------------------------------------------------------- 命令：move
function cmdMove() {
  const targets = String(opt('move'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const to = opt('to');
  if (!targets.length || to === undefined) {
    throw new Error('用法: --move <sessionId|标题关键词> --to <工作区标题|id|路径> [--dry] [--force]');
  }

  guardRunning();

  const { data } = loadWorkspaceJson();
  const dest = findWorkspace(data, to);
  if (!dest) throw new Error(`找不到工作区: ${to}`);
  if (!fs.existsSync(dest.path)) throw new Error(`目标工作区目录不存在: ${dest.path}`);
  // 写进 header 的 cwd 用真实路径：DSH 建会话时也解析过符号链接（macOS 的 /var → /private/var），
  // 用原样路径会和 DSH 自己的记录不一致。
  const destPath = fs.realpathSync(dest.path);
  console.log(`目标工作区: ${dest.title} [${dest.id}]\n  path=${destPath}`);

  const { items } = buildIndex(ROOT);

  const picked = [];
  for (const t of targets) {
    const lower = t.toLowerCase();
    const exact = items.filter((s) => s.id === t);
    const fuzzy = items.filter(
      (s) => s.id.toLowerCase().includes(lower) || String(titleOf(s.id) ?? '').toLowerCase().includes(lower),
    );
    const hit = exact.length === 1 ? exact[0] : fuzzy.length === 1 ? fuzzy[0] : undefined;
    if (hit === undefined) {
      if (fuzzy.length > 1) {
        throw new Error(
          `「${t}」命中了 ${fuzzy.length} 个会话，请写完整 id：\n` +
            fuzzy.map((s) => `  - ${s.id}  ${titleOf(s.id) ?? '-'}`).join('\n'),
        );
      }
      throw new Error(`找不到会话: ${t}`);
    }
    assertSessionId(hit.id, '会话 id');
    if (sameCwd(hit.cwd, destPath)) {
      console.log(`\n会话 ${hit.id} 已经在目标工作区，跳过。`);
      continue;
    }
    if (!picked.some((p) => p.id === hit.id)) picked.push(hit);
  }
  if (picked.length === 0) {
    console.log('\n没有要搬的会话。');
    return;
  }

  for (const s of picked) {
    console.log(`\n会话 ${s.id}\n  title  = ${titleOf(s.id) ?? '-'}\n  ${s.cwd}\n    ->  ${destPath}`);
    console.log(`  ${s.file}\n    ->  ${path.join(ROOT, projectKey(destPath), encodeSegment(s.id), LOG_NAME)}`);
  }

  if (DRY) {
    console.log('\n--dry：只打印计划，什么都没写。');
    return;
  }

  fs.mkdirSync(BACKUP, { recursive: true });
  console.log(`\n备份目录: ${BACKUP}`);

  for (const s of picked) {
    const moved = moveSessionFile({
      file: s.file,
      sessionsRoot: ROOT,
      sessionId: s.id,
      targetPath: destPath,
      backupDir: BACKUP,
    });
    console.log(`  OK ${s.id}: frames=${moved.frames} records=${moved.records} cwd=${moved.cwd}`);
    updateProjcache({ projcacheDir: PROJCACHE_DIR, sessionId: s.id, cwd: destPath, backupDir: BACKUP });
  }

  fs.writeFileSync(path.join(BACKUP, 'workspace.json'), Buffer.from(JSON.stringify(data, null, 2)));
  const movedIds = new Set(picked.map((p) => p.id));
  const table = data.tables?.workspaces ?? {};
  for (const [wsId, record] of Object.entries(table)) {
    const before = Array.isArray(record.sessionIds) ? record.sessionIds : [];
    const kept = before.filter((id) => !movedIds.has(id));
    record.sessionIds = wsId === dest.id ? [...[...movedIds].filter((id) => !kept.includes(id)), ...kept] : kept;
  }
  if (table[dest.id] !== undefined) table[dest.id].updatedAt = new Date().toISOString();
  fs.writeFileSync(WS_JSON, JSON.stringify(data, null, 2));

  const check = JSON.parse(fs.readFileSync(WS_JSON, 'utf8'));
  const destIds = check.tables?.workspaces?.[dest.id]?.sessionIds ?? [];
  const missing = [...movedIds].filter((id) => !destIds.includes(id));
  const leftovers = Object.entries(check.tables?.workspaces ?? {})
    .filter(([wsId]) => wsId !== dest.id)
    .flatMap(([, record]) => (record.sessionIds ?? []).filter((id) => movedIds.has(id)));
  if (missing.length > 0 || leftovers.length > 0) {
    console.error(`  workspace.json 写失败：缺 ${missing.join(', ') || '无'}；残留 ${leftovers.join(', ') || '无'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  workspace.json 已更新：${[...movedIds].join(', ')} -> ${dest.title}`);
  console.log(`\n完成。备份在 ${BACKUP}`);
  console.log('重新打开 DeepSeek Harness，索引会在启动时重扫，目标工作区里就能看到它。');
}

function sameCwd(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------- 命令：verify
function cmdVerify() {
  const id = assertSessionId(String(opt('verify')), '要校验的会话 id');
  const hit = listSessionDirs(ROOT).find((s) => path.basename(s.dir) === encodeSegment(id));
  if (!hit) {
    console.log(`MISSING ${id}`);
    process.exitCode = 1;
    return;
  }
  const buf = fs.readFileSync(hit.file);
  const frames = scanZstdFrames(buf);
  const plain1 = decodeFrame(frames[0]);
  const ok = plain1.indexOf(10) === plain1.length - 1;
  const header = JSON.parse(firstLine(plain1).toString('utf8'));
  const records = countRecords(frames);
  console.log(
    `id=${header.id}\nfile=${hit.file}\nframes=${frames.length}\nframe1=${frames[0].length}B 明文=${plain1.length}B\n` +
      `exactly-one-line=${ok}\nrecords=${records}\ncwd=${header.cwd}\nversion=${header.version}`,
  );
  if (!ok) process.exitCode = 1;
}

function cmdFrames() {
  const file = String(opt('frames'));
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  const plain1 = decodeFrame(frames[0]);
  console.log(
    `file=${file}\nbytes=${buf.length}\nframes=${frames.length}\nframe1=${frames[0].length}B 明文=${plain1.length}B ` +
      `exactly-one-line=${plain1.indexOf(10) === plain1.length - 1}`,
  );
  console.log(`header=${plain1.subarray(0, Math.min(plain1.length, 200)).toString('utf8')}`);
}

// ---------------------------------------------------------------- 入口
try {
  if (flag('list')) cmdList();
  else if (opt('move') !== undefined) cmdMove();
  else if (opt('verify') !== undefined) cmdVerify();
  else if (opt('frames') !== undefined) cmdFrames();
  else console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('*/')[0]);
} catch (error) {
  console.error('ERROR: ' + error.message);
  process.exitCode = 1;
}
