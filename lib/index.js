/**
 * 宿主半边：给客户端提供两个本地接口。
 *
 *   GET  /dsh-moving-context/api/list           → 工作区清单 + 每个工作区的会话数
 *   POST /dsh-moving-context/api/move           → { sessionId, workspaceId } 真的搬家
 *
 * 搬家用的是 DSH 自己的成员表（WorkspaceEntity.attachSession / detachSession），
 * 不手改 workspace.json —— 运行中的进程持有内存表，手改会被覆盖（这是上一个工具踩的坑）。
 * 文件层在 lib/core.js，成员表与索引刷新在这里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { moveSessionFile, updateProjcache } from './core.js';

export const API_PREFIX = '/dsh-moving-context/api';
const BODY_LIMIT = 64 * 1024;

const serviceOf = (ctx, name) => {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const send = (res, status, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

/** 找到会话当前所在的文件与工作区 */
const locate = async (hostCtx, sessionId) => {
  const persistence = serviceOf(hostCtx, 'sessionPersistence');
  const registry = serviceOf(hostCtx, 'workspaceRegistry');
  if (persistence === undefined || registry === undefined) throw new Error('DSH 服务还没就绪');
  const root = persistence.root;
  if (typeof root !== 'string') throw new Error('拿不到会话目录');

  const headers = await persistence.list();
  const found = headers.map((entry) => entry.header ?? entry).find((header) => header.id === sessionId);
  if (found === undefined) throw new Error(`找不到会话 ${sessionId}`);
  if (typeof found.cwd !== 'string') throw new Error('这个会话的 header 没有 cwd，无从搬起');

  const { projectKey, encodeSegment, LOG_NAME } = await import('./core.js');
  const file = path.join(root, projectKey(found.cwd), encodeSegment(sessionId), LOG_NAME);
  if (!fs.existsSync(file)) throw new Error(`会话文件不在预期位置: ${file}`);

  const owner = registry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
  return { root, file, header: found, owner };
};

const handleList = async (hostCtx, res) => {
  const registry = serviceOf(hostCtx, 'workspaceRegistry');
  if (registry === undefined) return send(res, 503, { error: 'workspaceRegistry 未就绪' });
  const workspaces = registry.list().map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessions: workspace.sessionIds.length,
  }));
  return send(res, 200, { workspaces });
};

const handleMove = async (hostCtx, req, res) => {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return send(res, 400, { error: '请求体不是 JSON' });
  }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
  if (sessionId === undefined || workspaceId === undefined) return send(res, 400, { error: '缺 sessionId 或 workspaceId' });

  const registry = serviceOf(hostCtx, 'workspaceRegistry');
  if (registry === undefined) return send(res, 503, { error: 'workspaceRegistry 未就绪' });
  const target = registry.get(workspaceId);
  if (target === undefined) return send(res, 404, { error: `没有工作区 ${workspaceId}` });
  if (!fs.existsSync(target.path)) return send(res, 409, { error: `目标工作区目录不存在: ${target.path}` });

  let spot;
  try {
    spot = await locate(hostCtx, sessionId);
  } catch (error) {
    return send(res, 404, { error: error.message });
  }
  if (spot.owner !== undefined && spot.owner.id === workspaceId) {
    return send(res, 200, { ok: true, unchanged: true, workspace: { id: target.id, title: target.title } });
  }
  if (path.resolve(spot.header.cwd) === path.resolve(target.path)) {
    // 文件已经在目标路径下，只差成员表
    if (spot.owner !== undefined) await spot.owner.detachSession(sessionId);
    await target.attachSession(sessionId);
    return send(res, 200, { ok: true, relocated: false, workspace: { id: target.id, title: target.title } });
  }

  // 正在这个进程里跑着的会话不动文件，免得写到一半被重新落在旧目录
  const sessions = serviceOf(hostCtx, 'sessions');
  if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
    return send(res, 409, { error: '这个对话正在打开，先切到别的对话再搬它' });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const home = path.join(os.homedir(), '.dsh');
  const backupDir = path.join(home, 'session-move-backup', stamp);

  let moved;
  try {
    moved = moveSessionFile({
      file: spot.file,
      sessionsRoot: spot.root,
      sessionId,
      targetPath: target.path,
      backupDir,
    });
  } catch (error) {
    return send(res, 500, { error: `搬文件失败: ${error.message}` });
  }

  try {
    updateProjcache({
      projcacheDir: path.join(home, 'storages', 'session_projcache', 'sessions'),
      sessionId,
      cwd: moved.cwd,
      backupDir,
    });
  } catch (error) {
    // 缓存修不好不影响搬家，DSH 会自己重建
    hostCtx.logger?.warn?.(`[moving-context] projcache 更新失败: ${error.message}`);
  }

  // 重建 header 索引，然后走官方成员表
  const registryAny = registry;
  try {
    if (typeof registryAny.replaceHeaderIndex === 'function' && typeof registryAny.listStoredHeaders === 'function') {
      await registryAny.replaceHeaderIndex(await registryAny.listStoredHeaders());
    }
    if (spot.owner !== undefined) await spot.owner.detachSession(sessionId);
    await target.attachSession(sessionId);
  } catch (error) {
    return send(res, 500, {
      error: `文件搬好了，但成员表没更新成: ${error.message}`,
      file: moved.newFile,
      hint: '重启一次工作台即可自愈',
    });
  }

  return send(res, 200, {
    ok: true,
    workspace: { id: target.id, title: target.title, path: target.path },
    frames: moved.frames,
    records: moved.records,
    file: moved.newFile,
    backup: backupDir,
  });
};

/** 客户端注册时用这个前缀探活 */
const handleRequest = async (hostCtx, req, res) => {
  const url = req.url ?? '';
  const route = url.slice(url.indexOf(API_PREFIX) + API_PREFIX.length).split('?')[0].replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && (route === '/list' || route === '')) return await handleList(hostCtx, res);
    if (req.method === 'POST' && route === '/move') return await handleMove(hostCtx, req, res);
    return send(res, 404, { error: `没有这个接口: ${req.method} ${route}` });
  } catch (error) {
    return send(res, 500, { error: error?.message ?? String(error) });
  }
};

export function apply(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.effect !== 'function') return;
  let installed = false;
  const install = (hostCtx) => {
    if (installed) return;
    const webServer = serviceOf(hostCtx, 'webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    installed = true;
    hostCtx.effect(() => {
      let dispose = () => {};
      try {
        dispose = webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => {
            void handleRequest(hostCtx, req, res);
          },
        });
      } catch (error) {
        console.warn('[moving-context] 路由注册失败:', error);
        return () => {};
      }
      return () => {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          // 宿主已经在拆了
        }
      };
    }, 'moving-context: 会话搬家接口');
  };
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], install);
      return;
    } catch {
      // 落到直接查
    }
  }
  install(ctx);
}
