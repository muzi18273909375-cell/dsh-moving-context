#!/usr/bin/env node
/**
 * make-fixture.mjs — 造一个和真实 ~/.dsh 结构一致、但完全合成的测试沙箱。
 *
 * 目的：让测试可以在任何机器（含 GitHub Actions 的 ubuntu-latest）上跑，
 * 不碰任何人的真实会话。
 *
 * 结构：
 *   <home>/storages/workspace.json
 *   <home>/storages/session_projcache/sessions/<id>.json
 *   <home>/sessions/<projectKey(srcPath)>/<id>/session.v4.jsonl.zstd
 *
 * 会话文件按 DSH 真实格式写：第一帧恰好一行 header（以 \n 结尾），正文另起一帧。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHECKSUM = zlib.constants.ZSTD_c_checksumFlag;

/** 与 DSH 的 compressZstdFrame 一致：带 checksum。 */
export function compress(input) {
  return zlib.zstdCompressSync(input, { params: { [CHECKSUM]: 1 } });
}

/**
 * DSH 的工程目录命名规则：盘符/分隔符压成 '-'，
 * [A-Za-z0-9._-] 原样，其余码元写成 ~XXXX（大写十六进制，至少 4 位），首尾各包 '--'。
 */
export function projectKey(target) {
  const raw = target.replace(/[\\/:]+/g, '-');
  let out = '';
  for (const ch of raw) {
    out += /[A-Za-z0-9._-]/.test(ch)
      ? ch
      : '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return ('--' + out.replace(/^-+/, '') + '--').slice(0, 251);
}

export function buildSessionFile(header, records) {
  const frame1 = compress(Buffer.from(JSON.stringify(header) + '\n'));
  const frame2 = compress(Buffer.from(records.map((r) => JSON.stringify(r) + '\n').join('')));
  return Buffer.concat([frame1, frame2]);
}

/**
 * 造沙箱。返回 { home, srcPath, dstPath, srcId, dstId, sessions: [{id, title, records}] }。
 */
export function makeFixture(root) {
  const home = root;
  const srcPath = path.join(home, 'work', 'ws-alpha');
  const dstPath = path.join(home, 'work', 'ws-beta');
  fs.mkdirSync(srcPath, { recursive: true });
  fs.mkdirSync(dstPath, { recursive: true });
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });

  const SRC_WS = 'aaaaaaaa-0000-4000-8000-000000000001';
  const DST_WS = 'bbbbbbbb-0000-4000-8000-000000000002';

  const now = new Date().toISOString();
  const workspaceJson = {
    unit: { name: 'workspace', version: 1 },
    global: {
      initialized: true,
      defaultWorkspaceId: SRC_WS,
      workspaceIds: [SRC_WS, DST_WS],
      archivedSessionIds: [],
    },
    tables: {
      workspaces: {
        [SRC_WS]: {
          id: SRC_WS,
          path: srcPath,
          title: 'ws-alpha',
          createdAt: now,
          updatedAt: now,
          sessionIds: [],
        },
        [DST_WS]: {
          id: DST_WS,
          path: dstPath,
          title: 'ws-beta',
          createdAt: now,
          updatedAt: now,
          sessionIds: [],
        },
      },
    },
  };

  const big = [];
  for (let i = 0; i < 40; i++) big.push({ type: 'test/record', n: i, note: '批量记录，用来验证记录数不会丢' });

  const sessions = [
    { id: 'session-11111111-1111-4111-8111-111111111111', title: '小会话', records: [{ type: 'test/record', n: 0 }] },
    { id: 'session-22222222-2222-4222-8222-222222222222', title: '大会话', records: big },
  ];

  for (const s of sessions) {
    const header = {
      type: 'session',
      version: 4,
      id: s.id,
      createdAt: Date.now(),
      cwd: srcPath,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'default',
    };
    const dir = path.join(home, 'sessions', projectKey(srcPath), s.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buildSessionFile(header, s.records));

    fs.writeFileSync(
      path.join(home, 'storages', 'session_projcache', 'sessions', s.id + '.json'),
      JSON.stringify(
        {
          version: 7,
          record: {
            identity: { cwd: srcPath },
            rows: {
              title: { val: s.title },
              workingDirectory: { val: srcPath },
              sessionListMetadata: { val: { blank: false, lastPromptAt: Date.now() } },
            },
          },
        },
        null,
        2,
      ),
    );
    workspaceJson.tables.workspaces[SRC_WS].sessionIds.push(s.id);
  }

  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(workspaceJson, null, 2));

  return { home, srcPath, dstPath, srcWs: SRC_WS, dstWs: DST_WS, sessions };
}

export function defaultRoot() {
  return path.join(os.tmpdir(), 'dsh-moving-context-test-' + process.pid);
}
