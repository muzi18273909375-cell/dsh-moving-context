/**
 * 插件宿主那半边的测试：lib/core.js 直接跑合成沙箱，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { makeFixture, projectKey } from './make-fixture.mjs';
import {
  countRecords,
  decodeFrame,
  firstLine,
  moveSessionFile,
  readSessionFile,
  scanZstdFrames,
  updateProjcache,
} from '../lib/core.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-host-'));
let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
};

try {
  const fixture = makeFixture(root);
  const big = fixture.sessions.find((s) => s.title === '大会话');
  const sessionsRoot = path.join(root, 'sessions');
  const oldFile = path.join(sessionsRoot, projectKey(fixture.srcPath), big.id, 'session.v4.jsonl.zstd');
  const backupDir = path.join(root, 'session-move-backup', 'test');
  const before = readSessionFile(oldFile);

  const moved = moveSessionFile({
    file: oldFile,
    sessionsRoot,
    sessionId: big.id,
    targetPath: fixture.dstPath,
    backupDir,
  });

  ok('文件落到目标工作区的工程目录', () => {
    assert.equal(moved.newFile, path.join(sessionsRoot, projectKey(fs.realpathSync(fixture.dstPath)), big.id, 'session.v4.jsonl.zstd'));
    assert.ok(fs.existsSync(moved.newFile));
  });

  ok('第一帧还是恰好一行 header，内容是新的 cwd', () => {
    const buf = fs.readFileSync(moved.newFile);
    const plain = decodeFrame(scanZstdFrames(buf, 1)[0]);
    assert.equal(plain.indexOf(10), plain.length - 1);
    const header = JSON.parse(firstLine(plain).toString('utf8'));
    assert.equal(header.cwd, fs.realpathSync(fixture.dstPath));
    assert.equal(header.id, big.id);
    assert.equal(header.createdAt, before.header.createdAt);
  });

  ok('记录一条不丢、帧数不变', () => {
    assert.equal(moved.records, 40);
    assert.equal(moved.frames, scanZstdFrames(fs.readFileSync(moved.newFile)).length);
    assert.equal(countRecords(scanZstdFrames(fs.readFileSync(moved.newFile))), 40);
  });

  ok('旧目录 retire 到备份，原位置不再有', () => {
    assert.equal(fs.existsSync(path.dirname(oldFile)), false);
    assert.ok(fs.existsSync(path.join(backupDir, path.basename(path.dirname(path.dirname(oldFile))), big.id)));
  });

  ok('projcache 的 identity.cwd 与 workingDirectory 都跟着走', () => {
    const pcDir = path.join(root, 'storages', 'session_projcache', 'sessions');
    const touched = updateProjcache({ projcacheDir: pcDir, sessionId: big.id, cwd: moved.cwd, backupDir });
    assert.equal(touched, true);
    const record = JSON.parse(fs.readFileSync(path.join(pcDir, big.id + '.json'), 'utf8')).record;
    assert.equal(record.identity.cwd, moved.cwd);
    assert.equal(record.rows.workingDirectory.val, moved.cwd);
    assert.equal(record.rows.title.val, '大会话');
    assert.ok(fs.existsSync(path.join(backupDir, big.id + '.projcache.json')));
  });

  ok('搬到同一个目标两次是幂等的（不重复写）', () => {
    const again = moveSessionFile({
      file: moved.newFile,
      sessionsRoot,
      sessionId: big.id,
      targetPath: fixture.dstPath,
      backupDir,
    });
    assert.equal(again.records, 40);
    assert.equal(fs.existsSync(moved.newFile), true);
  });

  ok('坏文件（第一帧不是一行 header）会报错而不是硬搬', () => {
    const badDir = path.join(sessionsRoot, projectKey(fixture.srcPath), 'session-bad');
    fs.mkdirSync(badDir, { recursive: true });
    const bad = path.join(badDir, 'session.v4.jsonl.zstd');
    const header = { type: 'session', version: 4, id: 'session-bad', cwd: fixture.srcPath };
    fs.writeFileSync(bad, Buffer.concat([
      // header 与正文压在同一帧里 —— 正是把 DSH 弄瞎的那种写法
      zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n{"type":"x"}\n')),
    ]));
    assert.throws(() => readSessionFile(bad), /not exactly one header line/);
    assert.throws(
      () => moveSessionFile({ file: bad, sessionsRoot, sessionId: 'session-bad', targetPath: fixture.dstPath }),
      /not exactly one header line/,
    );
  });

  console.log(`\n宿主层：通过 ${passed}，失败 0`);
} catch (error) {
  console.error('\n宿主层失败：', error.message);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (!process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
  else console.log('沙箱保留在 ' + root);
}
