/**
 * 纯文件层：zstd 帧、projectKey、会话文件重建与搬移、projcache 同步。
 * 不依赖 DSH、不碰 workspace.json —— 成员关系交给 DSH 自己的 WorkspaceEntity。
 *
 * 与 src/move-session.mjs 里的实现同源（那边是 CLI，这边给插件宿主用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

/** 按 zstd 帧结构切分（照抄 DSH 的 scanZstdFrames） */
export function scanZstdFrames(buf, maxFrames = Infinity) {
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
    if (!singleSegment) offset += 1;
    offset += [0, 1, 2, 4][dictFlag];
    offset += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];
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

export const zstdFrame = (plaintext) =>
  zlib.zstdCompressSync(plaintext, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

export const decodeFrame = (frame) => zlib.zstdDecompressSync(frame);

export const firstLine = (plaintext) => {
  const nl = plaintext.indexOf(10);
  if (nl === -1) throw new Error('header frame has no newline');
  return plaintext.subarray(0, nl + 1);
};

/** DSH 的工程目录名规则 */
export function projectKey(cwd) {
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

export const encodeSegment = (raw) => {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
};

export const LOG_NAME = 'session.v4.jsonl.zstd';
export const isLogName = (n) => /^session\.v\d+\.jsonl\.zstd$/.test(n);

export function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  const plain = decodeFrame(frames[0]);
  const line = firstLine(plain);
  if (plain.indexOf(10) !== plain.length - 1) {
    throw new Error('corrupt log: first frame is not exactly one header line');
  }
  return { buf, frames, header: JSON.parse(line.toString('utf8')) };
}

export function countRecords(frames) {
  let n = 0;
  for (const frame of frames.slice(1)) n += decodeFrame(frame).toString('utf8').split('\n').filter(Boolean).length;
  return n;
}

/** 把 cwd 写成新的第一帧，其余帧字节原样保留 */
export function rebuildWithCwd({ frames, header }, cwd) {
  const line = Buffer.from(JSON.stringify({ ...header, cwd }) + '\n', 'utf8');
  return Buffer.concat([zstdFrame(line), ...frames.slice(1)]);
}

/**
 * 把一个会话从旧工程目录搬到目标工作区路径下。
 * 返回 { newFile, frames, records, cwd }；调用方负责再跑 DSH 的索引刷新与成员表。
 */
export function moveSessionFile({ file, sessionsRoot, sessionId, targetPath, backupDir }) {
  const src = readSessionFile(file);
  const id = src.header.id;
  if (sessionId !== undefined && id !== sessionId) throw new Error(`header id mismatch: ${id} !== ${sessionId}`);
  const cwd = fs.realpathSync(targetPath);
  const rebuilt = rebuildWithCwd(src, cwd);
  const newFile = path.join(sessionsRoot, projectKey(cwd), encodeSegment(id), LOG_NAME);

  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  const tmp = newFile + '.tmp';
  fs.writeFileSync(tmp, rebuilt);
  fs.renameSync(tmp, newFile);

  const srcDir = path.dirname(file);
  if (path.resolve(srcDir) !== path.resolve(path.dirname(newFile))) {
    if (backupDir) {
      const retired = path.join(backupDir, path.basename(path.dirname(srcDir)), path.basename(srcDir));
      fs.mkdirSync(path.dirname(retired), { recursive: true });
      fs.renameSync(srcDir, retired);
    } else {
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  }

  // 读回校验
  const check = readSessionFile(newFile);
  if (check.header.cwd !== cwd) throw new Error('cwd 没改成目标路径');
  if (check.header.id !== id) throw new Error('id 变了');
  return { newFile, frames: check.frames.length, records: countRecords(check.frames), cwd, header: check.header };
}

/** projcache 是缓存，但 identity.cwd 与 workingDirectory 必须跟着走 */
export function updateProjcache({ projcacheDir, sessionId, cwd, backupDir }) {
  const pc = path.join(projcacheDir, sessionId + '.json');
  if (!fs.existsSync(pc)) return false;
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(pc, path.join(backupDir, sessionId + '.projcache.json'));
  }
  const j = JSON.parse(fs.readFileSync(pc, 'utf8'));
  const rec = j.record ?? j;
  if (rec.identity) rec.identity.cwd = cwd;
  if (rec.rows?.workingDirectory) rec.rows.workingDirectory.val = cwd;
  fs.writeFileSync(pc, JSON.stringify(j, null, 2));
  return true;
}
