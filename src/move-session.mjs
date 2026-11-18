#!/usr/bin/env node
/**
 * move-session.mjs — 把 DSH 会话在「工作区」之间搬家（官方没有这个功能）。
 *
 * 用法（先完全退出 DeepSeek Harness）：
 *   node move-session.mjs --list
 *   node move-session.mjs --move <sessionId|标题关键词> --to <工作区标题|工作区id> [--dry] [--force]
 *   node move-session.mjs --verify <sessionId>
 *
 * 可选：--home <DSH 数据根>   默认 C:\Users\<you>\.dsh
 *       --root <会话根>       默认 <home>\sessions
 *       --frames <file>       自检 zstd 帧扫描
 *
 * 它做的事（每一步都可回滚，备份统一放在 <home>\session-move-backup\<时间戳>\）：
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
import zlib from 'node:zlib';

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

const ZSTD_MAGIC = 0xfd2fb528;

// ---------------------------------------------------------------- zstd 帧
function scanZstdFrames(buf, maxFrames = Infinity) {
  const out = [];
  let offset = 0;
  while (offset < buf.length && out.length < maxFrames) {
    const start = offset;
    if (buf.length - offset < 4) throw new Error(`truncated zstd frame magic at ${offset}`);
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad zstd magic at ${offset}`);
    offset += 4;
    const fhd = buf[offset++];
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksumFlag = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!singleSegment) offset += 1;                       // window descriptor
    offset += [0, 1, 2, 4][dictFlag];                      // dictionary id
    offset += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];   // frame content size
    for (;;) {
      if (offset + 3 > buf.length) throw new Error(`truncated block header in frame at ${start}`);
      const bh = buf.readUIntLE(offset, 3);
      offset += 3;
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      offset += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksumFlag) offset += 4;
    out.push(buf.subarray(start, offset));
  }
  return out;
}

const zstdFrame = (plaintext) => zlib.zstdCompressSync(plaintext, {
  params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
});

const decodeFrame = (frame) => zlib.zstdDecompressSync(frame);

const firstLine = (plaintext) => {
  const nl = plaintext.indexOf(10);
  if (nl === -1) throw new Error('header frame has no newline');
  return plaintext.subarray(0, nl + 1);
};

/** DSH 的 projectKey：分隔符/盘符压成 -，其它不安全码元转 ~XXXX，首尾包 -- */
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

// ---------------------------------------------------------------- 扫描
function listSessionDirs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(root, proj.name);
    for (const ses of fs.readdirSync(projPath, { withFileTypes: true })) {
      if (!ses.isDirectory()) continue;
      const dir = path.join(projPath, ses.name);
      const files = fs.readdirSync(dir).filter(isLogName);
      for (const f of files) out.push({ projectKey: proj.name, dir, file: path.join(dir, f) });
    }
  }
  return out;
}

function readHeader(file) {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf, 1);
  const plain = decodeFrame(frames[0]);
  const line = firstLine(plain);
  return { buf, header: JSON.parse(line.toString('utf8')), frame1: frames[0], headerLength: line.length, frameCount: scanZstdFrames(buf).length };
}

function titleOf(id) {
  const p = path.join(PROJCACHE_DIR, id + '.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rec = j?.record ?? j;
    return rec?.rows?.title?.val ?? rec?.title ?? undefined;
  } catch { return undefined; }
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
  const lower = String(needle).toLowerCase();
  return all.find((w) => w.id === needle)
    ?? all.find((w) => String(w.title ?? '').toLowerCase().includes(lower))
    ?? all.find((w) => String(w.path ?? '').toLowerCase().includes(lower));
}

// ---------------------------------------------------------------- 命令：list
function cmdList() {
  const { data } = loadWorkspaceJson();
  const ids = new Set();
  for (const w of workspaces(data)) for (const s of w.sessionIds ?? []) ids.add(s);

  console.log(`工作区（${WS_JSON}）`);
  for (const w of workspaces(data)) {
    console.log(`  [${w.id}] ${w.title}\n      path=${w.path}\n      sessions=${(w.sessionIds ?? []).length}`);
  }

  console.log('\n磁盘上的会话');
  for (const s of listSessionDirs(ROOT)) {
    let h;
    try { h = readHeader(s.file); } catch (e) {
      console.log(`  BROKEN ${path.basename(s.dir)}  (${e.message})`);
      continue;
    }
    const id = h.header.id;
    const owner = workspaces(data).filter((w) => (w.sessionIds ?? []).includes(id)).map((w) => w.title);
    console.log(`  ${id}\n      title=${titleOf(id) ?? '-'}\n      cwd=${h.header.cwd}\n      workspace=${owner.length ? owner.join(' / ') : '(未登记)'}\n      frames=${h.frameCount} headerBytes=${h.headerLength}`);
  }
}

// ---------------------------------------------------------------- 命令：move
function cmdMove() {
  const targets = String(opt('move')).split(',').map((s) => s.trim()).filter(Boolean);
  const to = opt('to');
  if (!targets.length || !to) throw new Error('用法: --move <sessionId|标题关键词> --to <工作区标题|id> [--dry] [--force]');

  const { text, data } = loadWorkspaceJson();
  const dest = findWorkspace(data, to);
  if (!dest) throw new Error(`找不到工作区: ${to}`);
  if (!fs.existsSync(dest.path)) throw new Error(`目标工作区目录不存在: ${dest.path}`);
  const destPath = fs.realpathSync(dest.path);
  console.log(`目标工作区: ${dest.title} [${dest.id}]\n  path=${destPath}`);

  const all = listSessionDirs(ROOT);
  const picked = [];
  for (const t of targets) {
    const lower = t.toLowerCase();
    const hit = all.find((s) => {
      try {
        const h = readHeader(s.file).header;
        return h.id === t || String(h.id).includes(lower) || String(titleOf(h.id) ?? '').toLowerCase().includes(lower);
      } catch { return path.basename(s.dir).toLowerCase().includes(lower); }
    });
    if (!hit) throw new Error(`找不到会话: ${t}`);
    picked.push(hit);
  }

  const plans = [];
  for (const s of picked) {
    const { buf, header, frameCount } = readHeader(s.file);
    const newHeader = { ...header, cwd: destPath };
    const newPath = path.join(ROOT, projectKey(destPath), encodeSegment(header.id), LOG_NAME);
    plans.push({ src: s, buf, header, newHeader, newPath, frameCount });
    console.log(`\n会话 ${header.id}`);
    console.log(`  title  = ${titleOf(header.id) ?? '-'}`);
    console.log(`  ${header.cwd}\n    ->  ${destPath}`);
    console.log(`  ${s.file}\n    ->  ${newPath}   (frames=${frameCount})`);
  }

  if (DRY) { console.log('\n--dry：只打印计划，什么都没写。'); return; }

  // 1) 备份目录
  fs.mkdirSync(BACKUP, { recursive: true });
  console.log(`\n备份目录: ${BACKUP}`);

  // 2) 重写会话文件
  for (const p of plans) {
    const frames = scanZstdFrames(p.buf);
    const plain = decodeFrame(frames[0]);
    const line = firstLine(plain);
    const oldHeader = JSON.parse(line.toString('utf8'));
    if (oldHeader.id !== p.header.id) throw new Error('header id mismatch');

    const newLine = Buffer.from(JSON.stringify(p.newHeader) + '\n', 'utf8');
    const rebuilt = Buffer.concat([zstdFrame(newLine), ...frames.slice(1)]);

    fs.mkdirSync(path.dirname(p.newPath), { recursive: true });
    if (path.resolve(p.newPath) === path.resolve(p.src.file)) {
      // 同目录：直接覆盖
      fs.copyFileSync(p.src.file, path.join(BACKUP, p.header.id + '.orig'));
      const tmp = p.newPath + '.tmp';
      fs.writeFileSync(tmp, rebuilt);
      fs.renameSync(tmp, p.newPath);
    } else {
      const tmp = p.newPath + '.tmp';
      fs.writeFileSync(tmp, rebuilt);
      fs.renameSync(tmp, p.newPath);
      // 旧的 retire 到备份，然后删掉旧目录
      const dest = path.join(BACKUP, p.src.projectKey, path.basename(p.src.dir));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(p.src.dir, dest);
    }

    // 3) 读回校验
    const check = readHeader(p.newPath);
    const plainCheck = decodeFrame(scanZstdFrames(fs.readFileSync(p.newPath), 1)[0]);
    if (plainCheck.indexOf(10) !== plainCheck.length - 1) throw new Error('frame1 不是恰好一行 header');
    if (check.header.cwd !== destPath) throw new Error('cwd 没改成目标路径');
    if (check.header.id !== p.header.id) throw new Error('id 变了');
    const records = scanZstdFrames(fs.readFileSync(p.newPath)).slice(1)
      .reduce((n, f) => n + decodeFrame(f).toString('utf8').split('\n').filter(Boolean).length, 0);
    console.log(`  OK ${p.header.id}: frames=${check.frameCount} cwd=${check.header.cwd} records=${records}`);
  }

  // 4) projcache
  for (const p of plans) {
    const pc = path.join(PROJCACHE_DIR, p.header.id + '.json');
    if (!fs.existsSync(pc)) { console.log(`  (无 projcache) ${p.header.id}`); continue; }
    fs.copyFileSync(pc, path.join(BACKUP, p.header.id + '.projcache.json'));
    const j = JSON.parse(fs.readFileSync(pc, 'utf8'));
    const rec = j.record ?? j;
    if (rec.identity) rec.identity.cwd = destPath;
    if (rec.rows?.workingDirectory) rec.rows.workingDirectory.val = destPath;
    fs.writeFileSync(pc, JSON.stringify(j, null, 2));
    console.log(`  projcache 已更新 ${p.header.id}`);
  }

  // 5) workspace.json
  fs.writeFileSync(path.join(BACKUP, 'workspace.json'), text);
  const movedIds = new Set(plans.map((p) => p.header.id));
  // 注意：必须直接改 data.tables.workspaces 里的真对象，别改 workspaces() 返回的副本
  const table = data.tables?.workspaces ?? {};
  for (const [wsId, record] of Object.entries(table)) {
    const before = Array.isArray(record.sessionIds) ? record.sessionIds : [];
    const kept = before.filter((id) => !movedIds.has(id));
    record.sessionIds = wsId === dest.id ? [...[...movedIds].filter((id) => !kept.includes(id)), ...kept] : kept;
  }
  if (table[dest.id] !== undefined) table[dest.id].updatedAt = new Date().toISOString();
  fs.writeFileSync(WS_JSON, JSON.stringify(data, null, 2));

  // 读回断言：归属真的写进去了才算成功
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
  console.log('现在重新打开 DeepSeek Harness，索引会在启动时重扫，就能在目标工作区里看到它。');
}

// ---------------------------------------------------------------- 命令：verify
function cmdVerify() {
  const id = opt('verify');
  const all = listSessionDirs(ROOT);
  const hit = all.find((s) => path.basename(s.dir) === encodeSegment(String(id)) || s.dir.includes(id));
  if (!hit) { console.log(`MISSING ${id}`); process.exitCode = 1; return; }
  const buf = fs.readFileSync(hit.file);
  const frames = scanZstdFrames(buf);
  const plain1 = decodeFrame(frames[0]);
  const ok = plain1.indexOf(10) === plain1.length - 1;
  const header = JSON.parse(firstLine(plain1).toString('utf8'));
  const records = frames.slice(1).reduce((n, f) => n + decodeFrame(f).toString('utf8').split('\n').filter(Boolean).length, 0);
  console.log(`id=${header.id}\nfile=${hit.file}\nframes=${frames.length}\nframe1=${frames[0].length}B 明文=${plain1.length}B\nexactly-one-line=${ok}\nrecords=${records}\ncwd=${header.cwd}\nversion=${header.version}`);
  if (!ok) process.exitCode = 1;
}

function cmdFrames() {
  const file = opt('frames');
  const buf = fs.readFileSync(String(file));
  const frames = scanZstdFrames(buf);
  const plain1 = decodeFrame(frames[0]);
  console.log(`file=${file}\nbytes=${buf.length}\nframes=${frames.length}\nframe1=${frames[0].length}B 明文=${plain1.length}B exactly-one-line=${plain1.indexOf(10) === plain1.length - 1}`);
  console.log(`header=${plain1.subarray(0, Math.min(plain1.length, 200)).toString('utf8')}`);
}

// ---------------------------------------------------------------- 入口
try {
  if (flag('list')) cmdList();
  else if (opt('move')) cmdMove();
  else if (opt('verify')) cmdVerify();
  else if (opt('frames')) cmdFrames();
  else console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('*/')[0]);
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exitCode = 1;
}
