/**
 * 宿主半边：给客户端提供两个本地接口。
 *
 *   GET  /dsh-moving-context/api/list           → 工作区清单 + 每个工作区的会话数
 *   POST /dsh-moving-context/api/move           → { sessionId, workspaceId } 真的搬家
 *
 * 搬家用的是 DSH 自己的成员表（WorkspaceEntity.attachSession / detachSession），
 * 不手改 workspace.json —— 运行中的进程持有内存表，手改会被覆盖（这是上一个工具踩的坑）。
 * 文件层在 lib/core.js，成员表与索引刷新在这里。
 *
 * 安全取向：这是本机接口，不是公网服务。
 *   - 只接受同源请求（Origin 为空或与 Host 一致）+ JSON content-type，挡掉跨站表单；
 *   - 所有 id 先过 assertSessionId / 白名单，绝不参与路径拼接后再校验；
 *   - 同一时刻只允许一个搬移动作（全局队列），同一会话重复提交返回 409；
 *   - 响应统一 try/catch，绝不因为一次坏请求把宿主拖挂。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  assertSessionId,
  deriveHome,
  encodeSegment,
  LOG_NAME,
  moveSessionFile,
  projectKey,
  samePath,
  updateProjcache,
} from './core.js';

export const API_PREFIX = '/dsh-moving-context/api';
const BODY_LIMIT = 16 * 1024;
const MOVE_TIMEOUT_MS = 30_000;

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
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
};

/** 只认同源：浏览器跨站请求要么带 Origin（不匹配就拒），要么是表单（没有 JSON content-type，也拒） */
const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const parsed = new URL(origin);
      const host = req.headers.host;
      if (typeof host !== 'string' || parsed.host !== host) return false;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    } catch {
      return false;
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  return true;
};

const isJson = (req) => {
  const type = req.headers['content-type'];
  if (typeof type !== 'string') return false;
  return type.split(';')[0].trim().toLowerCase() === 'application/json';
};

/** 找到会话当前所在的文件与工作区（先问成员表，问不到再全量扫） */
const locate = async (hostCtx, sessionId) => {
  const persistence = serviceOf(hostCtx, 'sessionPersistence');
  const registry = serviceOf(hostCtx, 'workspaceRegistry');
  if (persistence === undefined || registry === undefined) throw new Error('DSH 服务还没就绪');
  const root = persistence.root;
  if (typeof root !== 'string') throw new Error('拿不到会话目录');

  const owner = registry.list().find((workspace) => workspace.sessionIds.includes(sessionId));

  // 快路：成员表给出了工作区，直接按它的 path 找文件，不读全量 header
  if (owner !== undefined && typeof owner.path === 'string') {
    const candidate = path.join(root, projectKey(owner.path), encodeSegment(sessionId), LOG_NAME);
    if (fs.existsSync(candidate)) {
      return { root, file: candidate, cwd: owner.path, owner };
    }
  }

  // 慢路：全量 header（DSH 自己也有缓存，通常不慢）
  const headers = await persistence.list();
  const found = headers.map((entry) => entry.header ?? entry).find((header) => header.id === sessionId);
  if (found === undefined) throw new Error(`找不到会话 ${sessionId}`);
  if (typeof found.cwd !== 'string') throw new Error('这个会话的 header 没有 cwd，无从搬起');
  const file = path.join(root, projectKey(found.cwd), encodeSegment(sessionId), LOG_NAME);
  if (!fs.existsSync(file)) throw new Error(`会话文件不在预期位置: ${file}`);
  return { root, file, cwd: found.cwd, owner, header: found };
};

const handleList = async (hostCtx, res) => {
  const registry = serviceOf(hostCtx, 'workspaceRegistry');
  if (registry === undefined) return send(res, 503, { error: 'workspaceRegistry 未就绪' });
  const workspaces = registry.list().map((workspace) => {
    // 目录已经不在的工作区（删了、挪了、外接盘拔了）不能作为搬家目标，
    // 否则会话会落到一个不存在的 cwd 上，重启后谁也看不见。
    let alive = false;
    try {
      alive = fs.statSync(workspace.path).isDirectory();
    } catch {
      alive = false;
    }
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessions: workspace.sessionIds.length,
      alive,
    };
  });
  return send(res, 200, { workspaces });
};

/** 同一时刻只搬一个；同一会话重复点击直接拒，避免两份文件打架 */
const inFlight = new Set();
let queue = Promise.resolve();

const withMoveLock = (sessionId, task) => {
  if (inFlight.has(sessionId)) {
    return Promise.reject(Object.assign(new Error('这个对话正在搬，稍等'), { statusCode: 409 }));
  }
  inFlight.add(sessionId);
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => inFlight.delete(sessionId));
};

const handleMove = async (hostCtx, req, res) => {
  if (!sameOrigin(req)) return send(res, 403, { error: '只接受同源请求' });
  if (!isJson(req)) return send(res, 415, { error: '请求体必须是 application/json' });

  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return send(res, 400, { error: '请求体不是 JSON' });
  }
  if (payload === null || typeof payload !== 'object') return send(res, 400, { error: '请求体必须是对象' });

  let sessionId;
  let workspaceId;
  try {
    sessionId = assertSessionId(payload.sessionId);
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
  workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
  if (workspaceId === undefined || workspaceId.length === 0 || workspaceId.length > 128) {
    return send(res, 400, { error: 'workspaceId 不合法' });
  }

  const registry = serviceOf(hostCtx, 'workspaceRegistry');
  if (registry === undefined) return send(res, 503, { error: 'workspaceRegistry 未就绪' });
  const target = registry.get(workspaceId);
  if (target === undefined) return send(res, 404, { error: `没有工作区 ${workspaceId}` });
  if (!fs.existsSync(target.path)) return send(res, 409, { error: `目标工作区目录不存在: ${target.path}` });

  try {
    const result = await withMoveLock(sessionId, async () => {
      const spot = await locate(hostCtx, sessionId);
      if (spot.owner !== undefined && spot.owner.id === workspaceId) {
        return { ok: true, unchanged: true, workspace: { id: target.id, title: target.title } };
      }

      // 正在这个进程里跑着的会话不动文件，免得写到一半被重新落在旧目录
      const sessions = serviceOf(hostCtx, 'sessions');
      const live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
      const alreadyThere = samePath(spot.cwd ?? spot.header?.cwd, target.path);

      if (!alreadyThere && live !== undefined) {
        return { status: 409, body: { error: '这个对话正在打开，先切到别的对话再搬它' } };
      }

      let moved;
      let backup = null;
      if (!alreadyThere) {
        const home = deriveHome(spot.root);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backup = path.join(home, 'session-move-backup', stamp);
        moved = await Promise.race([
          Promise.resolve().then(() =>
            moveSessionFile({
              file: spot.file,
              sessionsRoot: spot.root,
              sessionId,
              targetPath: target.path,
              backupDir: backup,
            }),
          ),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('搬移超时（30s）')), MOVE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);

        try {
          updateProjcache({
            projcacheDir: path.join(home, 'storages', 'session_projcache', 'sessions'),
            sessionId,
            cwd: moved.cwd,
            backupDir: backup,
          });
        } catch (error) {
          hostCtx.logger?.warn?.(`[moving-context] projcache 更新失败: ${error.message}`);
        }

        if (typeof registry.replaceHeaderIndex === 'function' && typeof registry.listStoredHeaders === 'function') {
          await registry.replaceHeaderIndex(await registry.listStoredHeaders());
        }
      }

      if (spot.owner !== undefined) {
        try {
          await spot.owner.detachSession(sessionId);
          await target.attachSession(sessionId);
        } catch (attachError) {
          // 文件已经搬过去了但成员表没改成 —— 会话会变成「谁也看不见」。
          // 先把成员关系挂回原工作区，再把文件搬回来，状态回到点这一下之前。
          let reattached = false;
          try {
            await spot.owner.attachSession(sessionId);
            reattached = true;
          } catch {
            reattached = false;
          }
          if (moved !== undefined && spot.cwd !== undefined) {
            try {
              moveSessionFile({
                file: moved.newFile,
                sessionsRoot: spot.root,
                sessionId,
                targetPath: spot.cwd,
                backupDir: path.join(backup ?? deriveHome(spot.root), 'rollback'),
              });
            } catch (rollbackError) {
              throw new Error(
                `成员表更新失败（${attachError.message}），而且文件回滚也失败了（${rollbackError.message}）。` +
                  `新文件在 ${moved.newFile}，旧目录在 ${backup}`,
              );
            }
            throw new Error(
              `成员表更新失败：${attachError.message}。` +
                (reattached
                  ? '文件已经搬回原工作区，会话没丢。'
                  : '文件已经搬回原工作区，但成员关系没挂回去，重启一次工作台即可恢复。'),
            );
          }
          throw attachError;
        }
      } else {
        await target.attachSession(sessionId);
      }

      return {
        ok: true,
        relocated: !alreadyThere,
        workspace: { id: target.id, title: target.title, path: target.path },
        frames: moved?.frames,
        records: moved?.records,
        file: moved?.newFile,
        backup,
      };
    });

    if (result !== null && typeof result === 'object' && result.status !== undefined) {
      return send(res, result.status, result.body);
    }
    return send(res, 200, result);
  } catch (error) {
    const status = error?.statusCode ?? 500;
    return send(res, status, { error: error?.message ?? String(error) });
  }
};

/** 客户端注册时用这个前缀探活 */
const handleRequest = async (hostCtx, req, res) => {
  const url = req.url ?? '';
  const at = url.indexOf(API_PREFIX);
  const route = (at === -1 ? url : url.slice(at + API_PREFIX.length)).split('?')[0].replace(/\/+$/, '');
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
            handleRequest(hostCtx, req, res).catch((error) => {
              try {
                send(res, 500, { error: error?.message ?? String(error) });
              } catch {
                /* 连接已经断了 */
              }
            });
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
          /* 宿主已经在拆了 */
        }
      };
    }, 'moving-context: 会话搬家接口');
  };
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], install);
      return;
    } catch {
      /* 落到直接查 */
    }
  }
  install(ctx);
}

/**
 * 只给测试用：把内部处理器露出来，好在假 ctx 上跑完整请求流程。
 * 生产路径永远走 apply()/webServer.register。
 */
export const __testing = { handleList, handleMove, locate, sameOrigin, isJson };
