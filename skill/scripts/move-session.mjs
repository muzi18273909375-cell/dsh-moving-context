#!/usr/bin/env node
// ---------------------------------------------------------------
// 本文件由 scripts/build-skill.mjs 生成，不要手改。
// 逻辑来源：lib/core.js + src/move-session.mjs
// 改完源码跑一次：npm run build:skill
// ---------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

// ===== lib/core.js =====
/**
 * 纯文件层：zstd 帧、projectKey、会话文件重建与搬移、projcache 同步。
 * 不依赖 DSH、不碰 workspace.json —— 成员关系交给 DSH 自己的 WorkspaceEntity。
 *
 * 设计约束（每一条都对应一个真实踩过的坑）：
 *   - 第一帧必须「恰好一行 header + \n」，其余帧字节一律不动（DSH 的 assertZstdHeaderFrame）；
 *   - 所有写入先写 .tmp 再 rename，进程被杀也不会留下半个文件；
 *   - 搬移要么整体成功，要么把源目录留在原地（失败自动回滚，不产生双份会话）；
 *   - 任何外部传入的 id / 路径都先校验，不允许出现 `..` 或分隔符（防路径穿越）。
 */

const ZSTD_MAGIC = 0xfd2fb528;

/** 会话 id 白名单：DSH 的形如 session-<uuid>，这里放宽到安全字符集，但绝不允许分隔符 */
const ID_PATTERN = /^session-[A-Za-z0-9._-]{1,100}$/;

function assertSessionId(value, label = 'sessionId') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`${label} 不合法: ${String(value).slice(0, 80)}`);
  }
  return value;
}

/** 按 zstd 帧结构切分（照抄 DSH 的 scanZstdFrames，加了越界检查） */
function scanZstdFrames(buf, maxFrames = Infinity) {
  const out = [];
  let offset = 0;
  const need = (n, what) => {
    if (offset + n > buf.length) throw new Error(`truncated zstd ${what} at ${offset}`);
  };
  while (offset < buf.length && out.length < maxFrames) {
    const start = offset;
    need(4, 'frame magic');
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad zstd magic at ${offset}`);
    offset += 4;
    need(1, 'frame header');
    const fhd = buf[offset++];
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksumFlag = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!singleSegment) offset += 1;
    offset += [0, 1, 2, 4][dictFlag];
    offset += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];
    if (offset > buf.length) throw new Error(`truncated zstd frame header at ${start}`);
    for (;;) {
      need(3, 'block header');
      const bh = buf.readUIntLE(offset, 3);
      offset += 3;
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      offset += type === 1 ? 1 : size;
      if (offset > buf.length) throw new Error(`truncated zstd block at ${start}`);
      if (last) break;
    }
    if (checksumFlag) offset += 4;
    if (offset > buf.length) throw new Error(`truncated zstd checksum at ${start}`);
    out.push(buf.subarray(start, offset));
  }
  return out;
}

const zstdFrame = (plaintext) =>
  zlib.zstdCompressSync(plaintext, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

const decodeFrame = (frame) => zlib.zstdDecompressSync(frame);

const firstLine = (plaintext) => {
  const nl = plaintext.indexOf(10);
  if (nl === -1) throw new Error('header frame has no newline');
  return plaintext.subarray(0, nl + 1);
};

/** DSH 的工程目录名规则 */
function projectKey(cwd) {
  if (!cwd) throw new Error('empty cwd');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

const encodeSegment = (raw) => {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
};

const LOG_NAME = 'session.v4.jsonl.zstd';
const isLogName = (n) => /^session\.v\d+\.jsonl\.zstd$/.test(n);

/**
 * 比较两个目录是否指向同一个位置。
 * Windows 上大小写不敏感；POSIX 上 /var 与 /private/var 这类符号链接必须解析后再比，
 * 否则 macOS 上「已经在目标工作区」会判错。
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p) => {
    let resolved = path.resolve(p);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // 路径不存在时退回未解析的形式
    }
    const trimmed = resolved.replace(/[\\/]+$/, '') || resolved;
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

/** 原子写：同目录 .tmp + rename，失败不留残骸 */
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清不掉也没关系 */
    }
    throw error;
  }
}

/** 只读第一帧，返回 header 与整份 buffer（整份 buffer 后面重建时还要用） */
function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const first = scanZstdFrames(buf, 1);
  if (first.length === 0) throw new Error('empty session log');
  const plain = decodeFrame(first[0]);
  const line = firstLine(plain);
  if (plain.indexOf(10) !== plain.length - 1) {
    throw new Error('corrupt log: first frame is not exactly one header line');
  }
  let header;
  try {
    header = JSON.parse(line.toString('utf8'));
  } catch (error) {
    throw new Error(`header 不是合法 JSON: ${error.message}`);
  }
  if (header !== null && typeof header === 'object' && header.id !== undefined) {
    assertSessionId(header.id, 'header.id');
  }
  return { buf, header, frame1: first[0] };
}

function countRecords(frames) {
  let n = 0;
  for (let i = 1; i < frames.length; i++) {
    const text = decodeFrame(frames[i]).toString('utf8');
    if (text.length === 0) continue;
    let lines = 0;
    for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) === 10) lines += 1;
    n += text.endsWith('\n') ? lines : lines + 1;
  }
  return n;
}

/** 把 cwd 写成新的第一帧，其余帧字节原样保留 */
function rebuildWithCwd({ frames, header }, cwd) {
  const line = Buffer.from(JSON.stringify({ ...header, cwd }) + '\n', 'utf8');
  return Buffer.concat([zstdFrame(line), ...frames.slice(1)]);
}

/**
 * 把一个会话从旧工程目录搬到目标工作区路径下。
 *
 * 返回值 { newFile, frames, records, cwd, header, retired? }。
 * 语义：
 *   - 目标目录/会话目录已存在且内容一致 → 幂等返回 unchanged；
 *   - 任何一步失败 → 把已经写出的目标文件删掉，源目录保持原样，抛错给调用方；
 *   - 旧目录是移动到 backupDir（rename，同盘瞬间完成），不是复制后删除。
 */
function moveSessionFile({ file, sessionsRoot, sessionId, targetPath, backupDir }) {
  assertSessionId(sessionId);
  const src = readSessionFile(file);
  const id = src.header.id;
  if (id !== sessionId) throw new Error(`header id mismatch: ${id} !== ${sessionId}`);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`目标工作区目录不存在: ${targetPath}`);
  }

  const cwd = fs.realpathSync(targetPath);
  const frames = src.buf.equals(src.frame1) ? [src.frame1] : scanZstdFrames(src.buf);
  const newFile = path.join(sessionsRoot, projectKey(cwd), encodeSegment(id), LOG_NAME);
  const newDir = path.dirname(newFile);
  const srcDir = path.dirname(file);
  const sameDir = path.resolve(srcDir) === path.resolve(newDir);

  if (sameDir) {
    if (samePath(src.header.cwd, cwd)) {
      return { newFile: file, frames: frames.length, records: countRecords(frames), cwd, header: src.header, unchanged: true };
    }
    const rebuilt = rebuildWithCwd({ frames, header: src.header }, cwd);
    if (backupDir) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(file, path.join(backupDir, id + '.orig'));
    }
    writeFileAtomic(newFile, rebuilt);
    const check = readSessionFile(newFile);
    if (!samePath(check.header.cwd, cwd)) throw new Error('cwd 没改成目标路径');
    return { newFile, frames: frames.length, records: countRecords(frames), cwd, header: check.header };
  }

  const rebuilt = rebuildWithCwd({ frames, header: src.header }, cwd);
  fs.mkdirSync(newDir, { recursive: true });
  writeFileAtomic(newFile, rebuilt);

  try {
    const check = readSessionFile(newFile);
    if (!samePath(check.header.cwd, cwd)) throw new Error('cwd 没改成目标路径');
    if (check.header.id !== id) throw new Error('id 变了');
    if (fs.statSync(newFile).size !== rebuilt.length) throw new Error('新文件长度不对');
  } catch (error) {
    try {
      fs.rmSync(newDir, { recursive: true, force: true });
    } catch {
      /* 残留目录比丢数据好 */
    }
    throw error;
  }

  // 旧目录处理：能进备份就进备份，进不去就原地留着（宁可留，不删）
  let retired;
  if (backupDir) {
    try {
      const target = path.join(backupDir, path.basename(path.dirname(srcDir)), path.basename(srcDir));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(srcDir, target);
      retired = target;
    } catch (error) {
      // 回滚：删掉新目录，让状态回到搬之前
      try {
        fs.rmSync(newDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw new Error(`旧目录进不了备份，已回滚: ${error.message}`);
    }
  } else {
    try {
      fs.rmSync(srcDir, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`旧目录删不掉，已保留新文件不动: ${error.message}`);
    }
  }

  const check = readSessionFile(newFile);
  return {
    newFile,
    frames: frames.length,
    records: countRecords(frames),
    cwd,
    header: check.header,
    retired,
  };
}

/** projcache 是缓存，但 identity.cwd 与 workingDirectory 必须跟着走 */
function updateProjcache({ projcacheDir, sessionId, cwd, backupDir }) {
  assertSessionId(sessionId);
  const pc = path.join(projcacheDir, sessionId + '.json');
  if (!fs.existsSync(pc)) return false;
  const raw = fs.readFileSync(pc, 'utf8');
  const j = JSON.parse(raw);
  const rec = j?.record ?? j;
  if (rec !== null && typeof rec === 'object') {
    if (rec.identity) rec.identity.cwd = cwd;
    if (rec.rows?.workingDirectory) rec.rows.workingDirectory.val = cwd;
  }
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, sessionId + '.projcache.json'), raw);
  }
  writeFileAtomic(pc, JSON.stringify(j, null, 2));
  return true;
}

/** 从 <home>/sessions 反推 DSH 数据根，避免和 os.homedir() 不一致 */
function deriveHome(sessionsRoot) {
  const resolved = path.resolve(sessionsRoot);
  return path.basename(resolved).toLowerCase() === 'sessions' ? path.dirname(resolved) : resolved;
}

/** 目录下有哪些 canonical 会话日志 */
function listSessionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isLogName);
}

// ===== src/move-session.mjs =====
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
    const out = execFileSync('pgrep', ['-fl', 'dsh'], { encoding: 'utf8', timeout: 8000 });
    const hit = out.split('\n').find((line) => /dsh(\.exe)?\b/i.test(line) && !line.includes('move-session'));
    return hit?.trim();
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
