/**
 * hardening.mjs — 安全 / 回滚 / 规模 三方面的加固测试。
 *
 * 覆盖：
 *   1. 会话 id 白名单（路径穿越、空值、非字符串）
 *   2. projcache 路径穿越被挡住
 *   3. 旧目录进备份失败时整体回滚（不产生双份会话）
 *   4. 目标工作区不存在 / 指向文件时报错，源文件不受影响
 *   5. 截断的 zstd 文件报可读错误，不是 RangeError
 *   6. 同路径重复搬是 no-op（unchanged）
 *   7. 规模：1200 个会话 / 6 个工作区，--list 认全且够快
 *   8. 大会话（3000 条记录、几 MB）搬完记录数一条不丢
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import {
  assertSessionId,
  countRecords,
  moveSessionFile,
  projectKey,
  readSessionFile,
  scanZstdFrames,
  updateProjcache,
} from '../lib/core.js';
import { buildSessionFile, makeFixture } from './make-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'src', 'move-session.mjs');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const ok = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    failed += 1;
    console.log('  FAIL ' + name + ' — ' + error.message);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-hard-'));

console.log('\n[1] 会话 id 白名单');
ok('正常 id 通过', () => {
  assert.equal(assertSessionId('session-11111111-1111-4111-8111-111111111111').startsWith('session-'), true);
});
ok('穿越被拒', () => {
  assert.throws(() => assertSessionId('../../etc/passwd'), /不合法/);
  assert.throws(() => assertSessionId('session-..'), /不合法/);
  assert.throws(() => assertSessionId('session-a/b'), /不合法/);
  assert.throws(() => assertSessionId('session-a\\b'), /不合法/);
  assert.throws(() => assertSessionId(''), /不合法/);
  assert.throws(() => assertSessionId(undefined), /不合法/);
  assert.throws(() => assertSessionId({ id: 'session-x' }), /不合法/);
});

console.log('\n[2] projcache 写入也走白名单');
ok('穿越 id 不会写到目录外', () => {
  const pcDir = path.join(root, 'projcache');
  fs.mkdirSync(pcDir, { recursive: true });
  assert.throws(
    () => updateProjcache({ projcacheDir: pcDir, sessionId: '../../boom', cwd: root }),
    /不合法/,
  );
  assert.equal(fs.existsSync(path.join(root, 'boom.json')), false);
});

console.log('\n[3] 回滚：旧目录进不了备份时不留双份');
ok('备份目录被占成文件 → 报错且源目录还在、目标不存在', () => {
  const fix = makeFixture(path.join(root, 'rb'));
  const big = fix.sessions.find((s) => s.title === '大会话');
  const sessionsRoot = path.join(fix.home, 'sessions');
  const srcFile = path.join(sessionsRoot, projectKey(fix.srcPath), big.id, 'session.v4.jsonl.zstd');
  const blocker = path.join(fix.home, 'blocked-backup');
  fs.writeFileSync(blocker, 'not a directory');

  let threw;
  try {
    moveSessionFile({
      file: srcFile,
      sessionsRoot,
      sessionId: big.id,
      targetPath: fix.dstPath,
      backupDir: blocker,
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, '应当抛错');
  assert.match(threw.message, /回滚|进不了备份/);
  assert.equal(fs.existsSync(srcFile), true, '源文件必须还在');
  const targetFile = path.join(sessionsRoot, projectKey(fs.realpathSync(fix.dstPath)), big.id, 'session.v4.jsonl.zstd');
  assert.equal(fs.existsSync(targetFile), false, '目标目录应该被回滚删掉');
});

console.log('\n[4] 目标路径异常');
ok('目标不存在 → 干净报错', () => {
  const fix = makeFixture(path.join(root, 'tp1'));
  const s = fix.sessions[0];
  const file = path.join(fix.home, 'sessions', projectKey(fix.srcPath), s.id, 'session.v4.jsonl.zstd');
  assert.throws(
    () =>
      moveSessionFile({
        file,
        sessionsRoot: path.join(fix.home, 'sessions'),
        sessionId: s.id,
        targetPath: path.join(fix.home, 'nope'),
      }),
    /目标工作区目录不存在/,
  );
  assert.equal(fs.existsSync(file), true);
});
ok('目标指向文件而不是目录 → 干净报错', () => {
  const fix = makeFixture(path.join(root, 'tp2'));
  const s = fix.sessions[0];
  const file = path.join(fix.home, 'sessions', projectKey(fix.srcPath), s.id, 'session.v4.jsonl.zstd');
  const notDir = path.join(fix.home, 'plain.txt');
  fs.writeFileSync(notDir, 'x');
  assert.throws(
    () =>
      moveSessionFile({
        file,
        sessionsRoot: path.join(fix.home, 'sessions'),
        sessionId: s.id,
        targetPath: notDir,
      }),
    /目标工作区目录不存在/,
  );
  assert.equal(fs.existsSync(file), true);
});

console.log('\n[5] 坏文件报可读错误');
ok('第一帧被截断 → truncated 而不是 RangeError', () => {
  const fix = makeFixture(path.join(root, 'bad'));
  const dir = path.join(fix.home, 'sessions', projectKey(fix.srcPath), 'session-deadbeef');
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: 'session-deadbeef', cwd: fix.srcPath };
  const whole = buildSessionFile(header, [{ type: 'x' }]);
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, whole.subarray(0, 12));
  assert.throws(() => readSessionFile(file), /truncated zstd/);
});
ok('正文帧被截断 → 搬家时报错，源文件不动', () => {
  const fix = makeFixture(path.join(root, 'bad2'));
  const dir = path.join(fix.home, 'sessions', projectKey(fix.srcPath), 'session-cafe1234');
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: 'session-cafe1234', cwd: fix.srcPath };
  const whole = buildSessionFile(
    header,
    Array.from({ length: 50 }, (_, n) => ({ type: 'x', n })),
  );
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, whole.subarray(0, whole.length - 9));
  assert.throws(
    () =>
      moveSessionFile({
        file,
        sessionsRoot: path.join(fix.home, 'sessions'),
        sessionId: 'session-cafe1234',
        targetPath: fix.dstPath,
      }),
    /truncated zstd/,
  );
  assert.equal(fs.existsSync(file), true, '源文件必须还在');
});
ok('空文件 → 报错', () => {
  const file = path.join(root, 'empty.zstd');
  fs.writeFileSync(file, Buffer.alloc(0));
  assert.throws(() => readSessionFile(file), /empty session log/);
});

console.log('\n[6] 幂等：已经在目标工作区再搬一次');
ok('unchanged=true，文件字节不变', () => {
  const fix = makeFixture(path.join(root, 'idem'));
  const s = fix.sessions[1];
  const sessionsRoot = path.join(fix.home, 'sessions');
  const srcFile = path.join(sessionsRoot, projectKey(fix.srcPath), s.id, 'session.v4.jsonl.zstd');
  const first = moveSessionFile({
    file: srcFile,
    sessionsRoot,
    sessionId: s.id,
    targetPath: fix.dstPath,
    backupDir: path.join(fix.home, 'bk'),
  });
  const before = fs.readFileSync(first.newFile);
  const again = moveSessionFile({
    file: first.newFile,
    sessionsRoot,
    sessionId: s.id,
    targetPath: fix.dstPath,
    backupDir: path.join(fix.home, 'bk'),
  });
  assert.equal(again.unchanged, true);
  assert.equal(again.records, 40);
  assert.deepEqual(fs.readFileSync(again.newFile), before);
});

console.log('\n[7] 规模：1200 个会话 / 6 个工作区');
ok('--list 认全 1200 个会话且不超时', () => {
  const bigHome = path.join(root, 'scale');
  const wsCount = 6;
  const perWs = 200;
  const workspaces = {};
  const now = new Date().toISOString();
  for (let w = 0; w < wsCount; w++) {
    const wsId = `ws-${w}`;
    const wsPath = path.join(bigHome, 'work', wsId);
    fs.mkdirSync(wsPath, { recursive: true });
    workspaces[wsId] = {
      id: wsId,
      path: wsPath,
      title: wsId,
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
    };
    const projDir = path.join(bigHome, 'sessions', projectKey(wsPath));
    fs.mkdirSync(projDir, { recursive: true });
    for (let i = 0; i < perWs; i++) {
      const id = `session-${String(w).repeat(8)}-${String(i).padStart(4, '0')}-4000-8000-${String(i).padStart(12, '0')}`;
      const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: wsPath };
      const dir = path.join(projDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'session.v4.jsonl.zstd'),
        buildSessionFile(header, [{ type: 'test/record', n: i }]),
      );
      workspaces[wsId].sessionIds.push(id);
    }
  }
  fs.mkdirSync(path.join(bigHome, 'storages'), { recursive: true });
  fs.writeFileSync(
    path.join(bigHome, 'storages', 'workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 1 }, global: {}, tables: { workspaces } }),
  );

  const started = Date.now();
  const out = execFileSync(NODE, [CLI, '--list', '--json', '--home', bigHome, '--force'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const parsed = JSON.parse(out);
  assert.equal(parsed.sessions.length, wsCount * perWs);
  assert.equal(parsed.broken.length, 0);
  console.log(`        ${wsCount * perWs} 个会话，--list 用时 ${ms}ms`);
  assert.ok(ms < 60_000, `--list 太慢：${ms}ms`);

  const target = path.join(bigHome, 'work', 'ws-0');
  const victim = workspaces['ws-5'].sessionIds[0];
  execFileSync(NODE, [CLI, '--move', victim, '--to', 'ws-0', '--home', bigHome, '--force'], {
    encoding: 'utf8',
  });
  const movedFile = path.join(bigHome, 'sessions', projectKey(fs.realpathSync(target)), victim, 'session.v4.jsonl.zstd');
  assert.equal(fs.existsSync(movedFile), true, '搬完应该在 ws-0 的工程目录里');
});

console.log('\n[8] 大会话：3000 条记录');
ok('几 MB 的会话搬完记录一条不丢', () => {
  const fix = makeFixture(path.join(root, 'huge'));
  const id = 'session-33333333-3333-4333-8333-333333333333';
  const wsPath = fix.srcPath;
  const dir = path.join(fix.home, 'sessions', projectKey(wsPath), id);
  fs.mkdirSync(dir, { recursive: true });
  const records = [];
  for (let i = 0; i < 3000; i++) {
    // 随机内容，避免压缩率把文件压成几 KB —— 要测的是真实体量
    records.push({ type: 'test/record', n: i, pad: randomBytes(900).toString('hex') });
  }
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: wsPath };
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, buildSessionFile(header, records));
  const sizeMb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);

  const started = Date.now();
  const moved = moveSessionFile({
    file,
    sessionsRoot: path.join(fix.home, 'sessions'),
    sessionId: id,
    targetPath: fix.dstPath,
    backupDir: path.join(fix.home, 'bk-huge'),
  });
  const ms = Date.now() - started;
  console.log(`        ${sizeMb}MB / 3000 条，搬家用时 ${ms}ms`);
  assert.equal(moved.records, 3000);
  assert.equal(countRecords(scanZstdFrames(fs.readFileSync(moved.newFile))), 3000);
  assert.ok(ms < 20_000, `大文件搬家太慢：${ms}ms`);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n加固测试：通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
