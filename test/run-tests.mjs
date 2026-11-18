#!/usr/bin/env node
/**
 * run-tests.mjs — dsh-moving-context 的自动化测试。
 *
 * 全部在临时目录里跑合成数据，不碰真实 ~/.dsh。
 * 覆盖：--list 归属识别、--dry 不写盘、真搬（文件+归属+projcache）、--verify、
 *       记录数不丢、往返搬回、--frames 自检、错误输入要有非零退出码、备份可回滚。
 *
 * 用法：node test/run-tests.mjs [--keep]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixture, defaultRoot, projectKey } from './make-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'move-session.mjs');
const NODE = process.execPath;
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name + (detail === undefined ? '' : ` — ${detail}`));
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' — ' + detail}`);
  }
}

function run(args, expectFail = false) {
  // 测试跑在沙箱 --home 上，跟真实工作台无关；--force 跳过「检测 DSH 是否在运行」那道闸
  const full = [...args, '--force'];
  try {
    const out = execFileSync(NODE, [CLI, ...full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (expectFail) throw new Error('本该失败却成功了：' + full.join(' '));
    return { code: 0, out };
  } catch (error) {
    if (!expectFail) throw error;
    return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

const root = defaultRoot();
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const fx = makeFixture(root);
// macOS 的临时目录是符号链接（/var → /private/var），CLI 写进 header 的是解析后的真实路径
const realSrc = fs.realpathSync(fx.srcPath);
const realDst = fs.realpathSync(fx.dstPath);

try {
  console.log(`沙箱: ${root}`);

  console.log('\n[1] --list 能同时看到两个工作区和两条会话');
  {
    const { out } = run(['--list', '--home', root]);
    ok('列出 ws-alpha', out.includes('ws-alpha'));
    ok('列出 ws-beta', out.includes('ws-beta'));
    ok('两条会话都在', fx.sessions.every((s) => out.includes(s.id)));
    ok('归属识别为 ws-alpha', out.includes('workspace=ws-alpha'));
  }

  console.log('\n[2] --dry 只打印计划，一个字节都不写');
  {
    const before = fs.readFileSync(path.join(root, 'storages', 'workspace.json'), 'utf8');
    const { out } = run(['--move', fx.sessions[0].id, '--to', 'ws-beta', '--home', root, '--dry']);
    ok('打印了 --dry 提示', out.includes('--dry'));
    ok('workspace.json 未被改动', fs.readFileSync(path.join(root, 'storages', 'workspace.json'), 'utf8') === before);
  }

  console.log('\n[3] 真搬：标题关键词匹配 + 归属/文件/projcache 同步');
  {
    const s = fx.sessions[1]; // 40 条记录的大会话，用标题关键词搬
    const { out } = run(['--move', s.title, '--to', 'ws-beta', '--home', root]);
    ok('搬完打印 OK', /OK .*records=40/.test(out));

    const newFile = path.join(root, 'sessions', projectKey(realDst), s.id, 'session.v4.jsonl.zstd');
    const oldFile = path.join(root, 'sessions', projectKey(realSrc), s.id, 'session.v4.jsonl.zstd');
    ok('文件落到目标的 projectKey 目录', fs.existsSync(newFile));
    ok('源目录的会话文件已退场', !fs.existsSync(oldFile));

    const ws = JSON.parse(fs.readFileSync(path.join(root, 'storages', 'workspace.json'), 'utf8'));
    ok('目标工作区 sessionIds 含它', ws.tables.workspaces[fx.dstWs].sessionIds.includes(s.id));
    ok('源工作区 sessionIds 已移除', !ws.tables.workspaces[fx.srcWs].sessionIds.includes(s.id));

    const cache = JSON.parse(fs.readFileSync(path.join(root, 'storages', 'session_projcache', 'sessions', s.id + '.json'), 'utf8'));
    ok('projcache identity.cwd 已改', cache.record.identity.cwd === realDst);
    ok('projcache workingDirectory 已改', cache.record.rows.workingDirectory.val === realDst);
    ok('projcache 标题没被弄坏', cache.record.rows.title.val === s.title);

    const backups = fs.readdirSync(path.join(root, 'session-move-backup'));
    ok('生成了备份目录', backups.length >= 1);
    const bkBytes = fs.readdirSync(path.join(root, 'session-move-backup', backups[0]), { recursive: true }).length;
    ok('备份目录不是空的', bkBytes > 0);
  }

  console.log('\n[4] --verify 读回校验：帧结构 / 单行 header / 记录数 / cwd');
  {
    const s = fx.sessions[1];
    const { out } = run(['--verify', s.id, '--home', root]);
    ok('exactly-one-line=true', out.includes('exactly-one-line=true'));
    ok('records=40', out.includes('records=40'));
    ok('cwd 是目标路径', out.includes(`cwd=${realDst}`));
    ok('version=4', out.includes('version=4'));
  }

  console.log('\n[5] 往返：再搬回原工作区，一切复原');
  {
    const s = fx.sessions[0];
    run(['--move', s.id, '--to', 'ws-beta', '--home', root]);
    const mid = run(['--verify', s.id, '--home', root]).out;
    ok('搬到 beta 后 cwd 正确', mid.includes(`cwd=${realDst}`));

    run(['--move', s.id, '--to', 'ws-alpha', '--home', root]);
    const back = run(['--verify', s.id, '--home', root]).out;
    ok('搬回后 cwd 复原', back.includes(`cwd=${realSrc}`));
    ok('搬回后记录数不变', back.includes('records=1'));

    const ws = JSON.parse(fs.readFileSync(path.join(root, 'storages', 'workspace.json'), 'utf8'));
    ok('搬家后 alpha 的 sessionIds 复原', ws.tables.workspaces[fx.srcWs].sessionIds.includes(s.id));
    ok('beta 里没有残留', !ws.tables.workspaces[fx.dstWs].sessionIds.includes(s.id));
  }

  console.log('\n[6] --frames 自检能认出「第一帧不是一行 header」的坏文件');
  {
    const bad = path.join(root, 'bad.jsonl.zstd');
    const zlib = await import('node:zlib');
    const one = zlib.default.zstdCompressSync(
      Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'x', cwd: fx.srcPath }) + '\n{"type":"a"}\n'),
      { params: { [zlib.default.constants.ZSTD_c_checksumFlag]: 1 } },
    );
    fs.writeFileSync(bad, one);
    const res = run(['--frames', bad], true);
    ok('坏文件被判定为不合格（非零退出）', res.code !== 0, `code=${res.code}`);
  }

  console.log('\n[7] 错误输入要明确失败，不能默默改坏');
  {
    const r1 = run(['--move', fx.sessions[0].id, '--to', '不存在的目标', '--home', root], true);
    ok('目标工作区不存在时非零退出', r1.code !== 0);
    const r2 = run(['--move', '不存在的会话', '--to', 'ws-beta', '--home', root], true);
    ok('会话不存在时非零退出', r2.code !== 0);
    const stillOk = run(['--verify', fx.sessions[0].id, '--home', root]).out;
    ok('失败的调用没破坏会话', stillOk.includes('records=1'));
  }

  console.log('\n[8] 让 DSH 自己复核（本机装了 DSH 才跑，否则 SKIP）');
  {
    const e2e = path.join(HERE, '..', 'src', 'e2e-check.mjs');
    const out = execFileSync(NODE, [e2e, path.join(root, 'sessions'), fx.sessions[0].id, fx.sessions[1].id], { encoding: 'utf8' });
    if (out.includes('SKIP')) {
      ok('跳过（本机无 DSH 安装）', true);
    } else {
      ok('DSH 认得出两条会话', out.includes('FOUND') && !out.includes('MISSING'));
      ok('formatStatus 都是 current', (out.match(/formatStatus=current/g) ?? []).length === 2, out.trim());
    }
  }
} finally {
  if (KEEP) console.log(`\n沙箱保留在 ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
