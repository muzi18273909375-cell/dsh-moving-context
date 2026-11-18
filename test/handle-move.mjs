/**
 * handle-move.mjs — 在假 ctx 上跑插件的完整请求流程（list / move），
 * 覆盖正常搬家、CSRF / content-type 拦截、成员表失败回滚、幂等、并发。
 *
 * 全程在临时目录里造合成数据，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { __testing } from '../lib/index.js';
import { makeFixture, projectKey } from './make-fixture.mjs';
import { readSessionFile } from '../lib/core.js';

const { handleList, handleMove } = __testing;

// macOS 的临时目录是符号链接（/var → /private/var）；插件写进 header 的是真实路径
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

let passed = 0;
let failed = 0;
const ok = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    failed += 1;
    console.log('  FAIL ' + name + ' — ' + error.message);
  }
};

/** 假的 http 响应，记录状态码和 body */
const fakeRes = () => {
  const res = {
    headersSent: false,
    writableEnded: false,
    status: 0,
    payload: undefined,
    writeHead(status) {
      res.status = status;
      res.headersSent = true;
    },
    end(text) {
      res.payload = text === undefined ? undefined : JSON.parse(text);
      res.writableEnded = true;
    },
  };
  return res;
};

/** 假的 http 请求（Readable 带 headers） */
const fakeReq = ({ body, headers = {}, url = '/dsh-moving-context/api/move', method = 'POST' } = {}) => {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    host: '127.0.0.1:52963',
    origin: 'http://127.0.0.1:52963',
    'content-type': 'application/json',
    ...headers,
  };
  return stream;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-hm-'));

/** 起一套假宿主：成员表 + 持久化，行为跟 DSH 对齐到够用 */
const makeHost = (fixture) => {
  const memberships = new Map();
  for (const [wsId, ws] of Object.entries(fixture.workspaces ?? {})) {
    memberships.set(wsId, [...ws.sessionIds]);
  }
  if (memberships.size === 0) {
    memberships.set('ws-alpha', fixture.sessions.map((s) => s.id));
    memberships.set('ws-beta', []);
  }
  memberships.set('ws-dead', []);

  const workspaces = [
    { id: 'ws-alpha', title: 'ws-alpha', path: fixture.srcPath },
    { id: 'ws-beta', title: 'ws-beta', path: fixture.dstPath },
    // 目录已经不存在的那个：删了 / 挪走 / 外接盘拔了
    { id: 'ws-dead', title: 'ws-dead', path: path.join(fixture.home, 'gone-forever') },
  ];

  const registry = {
    failAttachFor: undefined,
    list: () => workspaces.map((w) => entityOf(w)),
    get: (id) => {
      const found = workspaces.find((w) => w.id === id);
      return found === undefined ? undefined : entityOf(found);
    },
    replaceHeaderIndex: async () => {},
    listStoredHeaders: async () => [],
  };

  /** 跟 DSH 的 WorkspaceEntity 一样：list()/get() 拿到的都能直接调方法 */
  function entityOf(found) {
    return {
      ...found,
      get sessionIds() {
        return memberships.get(found.id) ?? [];
      },
      attachSession: async (sessionId) => {
        if (registry.failAttachFor === found.id) throw new Error('attach 被拒绝（模拟）');
        const list = memberships.get(found.id) ?? [];
        if (!list.includes(sessionId)) list.push(sessionId);
        memberships.set(found.id, list);
      },
      detachSession: async (sessionId) => {
        memberships.set(
          found.id,
          (memberships.get(found.id) ?? []).filter((id) => id !== sessionId),
        );
      },
    };
  }

  const persistence = {
    root: path.join(fixture.home, 'sessions'),
    list: async () => [],
  };

  const hostCtx = {
    get: (name) => ({ workspaceRegistry: registry, sessionPersistence: persistence })[name],
    logger: { warn: () => {} },
  };

  return { hostCtx, registry, memberships };
};

try {
  const fixture = makeFixture(root);
  const { hostCtx, registry, memberships } = makeHost(fixture);
  const victim = fixture.sessions[0];
  const srcFile = path.join(fixture.home, 'sessions', projectKey(fixture.srcPath), victim.id, 'session.v4.jsonl.zstd');

  await ok('list 返回工作区与会话数', async () => {
    const res = fakeRes();
    await handleList(hostCtx, res);
    assert.equal(res.status, 200);
    assert.equal(res.payload.workspaces.length, 3);
    assert.equal(res.payload.workspaces[0].sessions, fixture.sessions.length);
    assert.equal(res.payload.workspaces[0].alive, true);
    const dead = res.payload.workspaces.find((w) => w.id === 'ws-dead');
    assert.equal(dead.alive, false, '目录不在的工作区要标成 alive=false');
  });

  await ok('跨站 Origin 被 403 挡住', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: victim.id, workspaceId: 'ws-beta' }),
      headers: { origin: 'https://evil.example' },
    }), res);
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(srcFile), true, '文件必须没动');
  });

  await ok('非 JSON content-type 被 415 挡住', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: victim.id, workspaceId: 'ws-beta' }),
      headers: { 'content-type': 'text/plain' },
    }), res);
    assert.equal(res.status, 415);
    assert.equal(fs.existsSync(srcFile), true);
  });

  await ok('非法 sessionId 被 400 挡住', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: '../../etc/passwd', workspaceId: 'ws-beta' }),
    }), res);
    assert.equal(res.status, 400);
  });

  await ok('正常搬家：文件到目标、成员表跟着改', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: victim.id, workspaceId: 'ws-beta' }),
    }), res);
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.relocated, true);
    const newFile = path.join(fixture.home, 'sessions', projectKey(real(fixture.dstPath)), victim.id, 'session.v4.jsonl.zstd');
    assert.equal(fs.existsSync(newFile), true);
    assert.equal(fs.realpathSync(readSessionFile(newFile).header.cwd), real(fixture.dstPath));
    assert.equal(memberships.get('ws-beta').includes(victim.id), true);
    assert.equal(memberships.get('ws-alpha').includes(victim.id), false);
  });

  await ok('再搬一次是幂等（unchanged）', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: victim.id, workspaceId: 'ws-beta' }),
    }), res);
    assert.equal(res.status, 200);
    assert.equal(res.payload.unchanged, true);
  });

  await ok('成员表 attach 失败 → 文件搬回原工作区，不留下谁也不认的会话', async () => {
    const second = fixture.sessions[1];
    // 静置时文件在未解析路径的 key 下；插件写回时会用真实路径的 key
    const src2raw = path.join(fixture.home, 'sessions', projectKey(fixture.srcPath), second.id, 'session.v4.jsonl.zstd');
    const src2 = path.join(fixture.home, 'sessions', projectKey(real(fixture.srcPath)), second.id, 'session.v4.jsonl.zstd');
    assert.equal(fs.existsSync(src2raw), true);
    registry.failAttachFor = 'ws-beta';
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: second.id, workspaceId: 'ws-beta' }),
    }), res);
    registry.failAttachFor = undefined;
    assert.equal(res.status, 500, JSON.stringify(res.payload));
    assert.match(res.payload.error, /成员表更新失败/);
    assert.equal(fs.existsSync(src2), true, '文件应该被搬回原工作区');
    assert.equal(memberships.get('ws-alpha').includes(second.id), true, '原工作区成员关系还在');
    assert.equal(memberships.get('ws-beta').includes(second.id), false);
    assert.equal(fs.realpathSync(readSessionFile(src2).header.cwd), real(fixture.srcPath));
  });

  await ok('目标工作区目录不在（工作区还登记着）→ 409，文件不动', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: victim.id, workspaceId: 'ws-dead' }),
    }), res);
    assert.equal(res.status, 409);
    assert.match(res.payload.error, /目标工作区目录不存在/);
  });

  await ok('目标工作区不存在 → 404', async () => {
    const res = fakeRes();
    await handleMove(hostCtx, fakeReq({
      body: JSON.stringify({ sessionId: victim.id, workspaceId: 'ws-nope' }),
    }), res);
    assert.equal(res.status, 404);
  });

  await ok('同一会话并发点两次，第二次 409', async () => {
    const third = fixture.sessions[1];
    const body = JSON.stringify({ sessionId: third.id, workspaceId: 'ws-beta' });
    const resA = fakeRes();
    const resB = fakeRes();
    await Promise.all([
      handleMove(hostCtx, fakeReq({ body }), resA),
      handleMove(hostCtx, fakeReq({ body }), resB),
    ]);
    const statuses = [resA.status, resB.status].sort((x, y) => x - y);
    // 一个成功 200，一个 409（顺序取决于谁先落到 withMoveLock）
    assert.deepEqual(statuses, [200, 409]);
  });

  console.log(`\n插件请求层：通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
} catch (error) {
  console.error('\n插件请求层失败：', error.message);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
