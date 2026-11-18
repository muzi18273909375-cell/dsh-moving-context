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
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

/** 会话 id 白名单：DSH 的形如 session-<uuid>，这里放宽到安全字符集，但绝不允许分隔符 */
const ID_PATTERN = /^session-[A-Za-z0-9._-]{1,100}$/;

export function assertSessionId(value, label = 'sessionId') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`${label} 不合法: ${String(value).slice(0, 80)}`);
  }
  return value;
}

/** 按 zstd 帧结构切分（照抄 DSH 的 scanZstdFrames，加了越界检查） */
export function scanZstdFrames(buf, maxFrames = Infinity) {
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

/** Windows 上路径大小写不敏感，比较 cwd 必须归一 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p) => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** 原子写：同目录 .tmp + rename，失败不留残骸 */
export function writeFileAtomic(file, data) {
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
export function readSessionFile(file) {
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

export function countRecords(frames) {
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
export function rebuildWithCwd({ frames, header }, cwd) {
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
export function moveSessionFile({ file, sessionsRoot, sessionId, targetPath, backupDir }) {
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
export function updateProjcache({ projcacheDir, sessionId, cwd, backupDir }) {
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
export function deriveHome(sessionsRoot) {
  const resolved = path.resolve(sessionsRoot);
  return path.basename(resolved).toLowerCase() === 'sessions' ? path.dirname(resolved) : resolved;
}

/** 目录下有哪些 canonical 会话日志 */
export function listSessionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isLogName);
}
