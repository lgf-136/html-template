/* ============================================================
 * worker.js — Cloudflare Worker 入口(静态资源 + 鉴权 API + D1)
 * ------------------------------------------------------------
 * 与根目录 dev-server.js 职责一一对应,按 Workers 运行时适配:
 *   - 静态资源:由 wrangler.toml [assets] 在边缘网络直接托管
 *     (index.html / js / assets);未命中资源的请求(如 /api/*)
 *     才进入本 Worker,非 API 请求一律透传给 ASSETS 绑定
 *   - 数据库:Cloudflare D1(binding = DB),适配器 server/db/d1.js
 *
 * 纯逻辑复用 server/ 下的 CJS 模块(经 esbuild 打包,与 Node/Deno 同一份实现):
 *   - SCHEMA            server/db/schema.js
 *   - EXPIRY_MS         server/auth/expiry.js
 *   - matchesPassword   server/auth/password.js
 *   - sha256/findSession server/auth/session.js
 *   - 敏感键判定         server/security/sensitive.js
 *   - AES-256-GCM       server/security/core.js
 *   - API Hub 策略       server/hub/index.js(公开开关 / 鉴权方式 / 自定义路由)
 *
 * Worker 只保留传输层适配(原生 Response / env secret),不再重复实现上述逻辑。
 * 鉴权门禁与 Node 端一致:默认需会话令牌;API Hub 可配置公开 / 自定义鉴权。
 *
 * 环境变量(通过 `wrangler secret put` 设置,勿写入 wrangler.toml):
 *   AUTH_PASSWORD   登录密码(必设;缺失时登录直接报错,绝不生成随机密码)
 *   ENCRYPTION_KEY  敏感数据加密密钥,64 位 hex(生产必设;缺失时报错)
 *
 * 完整部署说明见 docs/deploy/cloudflare.md。
 * ============================================================ */

// 注意:Cloudflare 要求 ESM 格式(nodejs_compat 下 CJS 会报
// "no default export" 错误),因此本文件使用 import / export default。
import crypto from 'node:crypto';
import { init as initD1 } from './server/db/d1.js';
import { SCHEMA } from './server/db/schema.js';
import { EXPIRY_MS } from './server/auth/expiry.js';
import { matchesPassword } from './server/auth/password.js';
import { sha256, findSession } from './server/auth/session.js';
import { RESERVED_SETTINGS_PREFIX, isSensitiveKey } from './server/security/sensitive.js';
import { GLOBAL_WORKSPACE_ID, workspaceIdForKey } from './server/db/scope.js';
import { encryptWithKey, decryptWithKey } from './server/security/core.js';
import { createThrottle } from './server/auth/throttle.js';
import { SECURITY_HEADERS } from './server/http/headers.js';
import { createHub } from './server/hub/index.js';
import { createChat } from './server/chat/index.js';

/* ---------- 登录限流(仅统计密码错误次数;与 Node 路由共用 server/auth/throttle.js) ---------- */
const loginThrottle = createThrottle();

function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

/* ---------- 数据库(单例,每 isolate 一份) ---------- */
let _db = null;
function getDb(env) {
  if (!_db) _db = initD1({ binding: env.DB, schema: SCHEMA });
  return _db;
}

/* ---------- 首次启动:建表(每 isolate 一次;密码由 AUTH_PASSWORD secret 直接校验) ---------- */
let _boot = null;
function boot(db) {
  if (!_boot) {
    _boot = db.initSchema(SCHEMA).catch((e) => {
      _boot = null; // 失败后允许下次请求重试
      throw e;
    });
  }
  return _boot;
}

/* ---------- 密码校验:与 secret AUTH_PASSWORD 常量时间比较(纯比较在 server/auth/password.js) ---------- */
function verifyEnvPassword(password, env) {
  const expected = env.AUTH_PASSWORD;
  if (!expected) {
    throw new Error(
      '[auth] 未配置 AUTH_PASSWORD secret,请用 `wrangler secret put AUTH_PASSWORD` 设置后再登录'
    );
  }
  return matchesPassword(password, expected);
}

/* ---------- 敏感键加密(AES-256-GCM 实现在 server/security/core.js;密钥来自 secret) ---------- */
let _key = null;
function key(env) {
  if (_key) return _key;
  const hex = env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      '[crypto] 缺少 ENCRYPTION_KEY(64 位 hex),请用 `wrangler secret put ENCRYPTION_KEY` 设置'
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('[crypto] ENCRYPTION_KEY 必须是 64 位 hex(32 字节)');
  _key = buf;
  return _key;
}

function encrypt(plaintext, env) {
  return encryptWithKey(key(env), plaintext);
}

function decrypt(stored, env) {
  return decryptWithKey(key(env), stored);
}

/* ---------- HTTP 工具(Worker 原生 Response) ---------- */
function sendJson(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      SECURITY_HEADERS
    ),
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

/** 取静态资源白名单允许的 API 路由元信息(与 server/api/index.js 路由表对应) */
function matchStaticRoute(method, pathname) {
  const key = method + ' ' + pathname;
  const table = [
    { key: 'POST /api/auth/login', kind: 'login', public: true },
    { key: 'GET /api/auth/verify', kind: 'verify' },
    { key: 'POST /api/auth/logout', kind: 'logout' },
    { key: 'GET /api/settings', kind: 'getSettings' },
    { key: 'PUT /api/settings', kind: 'putSettings' },
    { key: 'DELETE /api/settings', kind: 'deleteSettings' },
    { key: 'GET /api/hub/state', kind: 'hubState', mgmt: true },
    { key: 'PUT /api/hub/config', kind: 'hubConfig', mgmt: true },
    { key: 'PUT /api/hub/history', kind: 'hubHistory', mgmt: true },
    { key: 'GET /api/chat/state', kind: 'chatState' },
    { key: 'PUT /api/chat/config', kind: 'chatConfig' },
    { key: 'GET /api/chat/conversations', kind: 'chatGetConversations' },
    { key: 'POST /api/chat/conversations', kind: 'chatPostConversation' },
    { key: 'PUT /api/chat/conversations', kind: 'chatPutConversation' },
    { key: 'DELETE /api/chat/conversations', kind: 'chatDeleteConversations' },
    { key: 'POST /api/chat/models', kind: 'chatModels' },
    { key: 'POST /api/chat/stream', kind: 'chatStream' },
  ];
  for (const r of table) {
    if (r.key === key) return r;
  }
  return null;
}

function normalizePath(pathname) {
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  return pathname || '/';
}

/* ---------- API 路由(与 server/api/index.js 的 createApiHandler 保持一致) ---------- */
async function handleApi(request, env, pathname) {
  const db = getDb(env);
  await boot(db); // 建表(幂等,仅首次真正执行)
  const method = request.method;
  pathname = normalizePath(pathname);
  const key = method + ' ' + pathname;

  // POST /api/auth/login(内置公开路由,始终无需令牌)
  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request);
    const password = typeof body.password === 'string' ? body.password : '';
    const expiry = typeof body.expiry === 'string' ? body.expiry : '24h';
    const ttl = EXPIRY_MS[expiry];
    if (!ttl) return sendJson(400, { error: 'bad_expiry', message: '不支持的失效选项' });
    const ip = clientIp(request);
    if (loginThrottle.isBlocked(ip)) {
      return sendJson(429, { error: 'too_many_attempts', message: '登录尝试过于频繁,请稍后再试' });
    }
    let ok;
    try {
      ok = verifyEnvPassword(password, env);
    } catch (e) {
      return sendJson(500, { error: 'no_auth_password', message: String((e && e.message) || e) });
    }
    if (!ok) {
      loginThrottle.recordFailure(ip);
      return sendJson(401, { error: 'bad_password', message: '密码错误' });
    }
    loginThrottle.clear(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    await db.run('INSERT INTO auth_sessions (token_hash, expires_at, note) VALUES (?, ?, ?)', [
      sha256(token),
      expiresAt,
      expiry,
    ]);
    return sendJson(200, { token, expiresAt, expiry });
  }

  /* ---------- API Hub:配置存取 + 公开/鉴权策略门禁(与 Node 端一致) ---------- */
  const hub = createHub({
    db,
    encrypt: (v) => encrypt(v, env),
    decrypt: (v) => decrypt(v, env),
    verifyPassword: (p) => verifyEnvPassword(p, env),
    matchesPassword,
  });
  const chat = createChat({
    db,
    encrypt: (v) => encrypt(v, env),
    decrypt: (v) => decrypt(v, env),
    fetchImpl: typeof fetch === 'function' ? fetch : null,
  });
  const state = await hub.loadAll();
  const staticMeta = matchStaticRoute(method, pathname);
  const custom = staticMeta
    ? null
    : state.config.customRoutes.find((c) => c.method + ' ' + c.path === key) || null;

  if (!staticMeta && !custom) return sendJson(404, { error: 'not_found' });

  // 管理接口强制会话鉴权;其余按 Hub 策略(公开开关 + 鉴权方式)
  let policy;
  if (staticMeta && staticMeta.mgmt) {
    policy = { public: false, auth: 'session', isHubMgmt: true };
  } else if (staticMeta && staticMeta.public) {
    policy = { public: true, auth: 'none', isHubMgmt: false };
  } else {
    policy = hub.policyFor(key, custom, state.config);
  }

  const auth = await hub.authorize(
    request,
    key,
    { auth: policy.auth, customId: custom ? custom.id : null },
    state
  );
  if (!auth.ok) return sendJson(auth.status, { error: auth.error, message: auth.message });
  const session = auth.session;

  // 自定义路由执行(echo / static)
  if (custom) {
    return hub.handleCustom(custom, request, null, (res, status, obj) => sendJson(status, obj));
  }

  // GET /api/hub/state — 路由发现(内置 + 自定义,不含管理接口)+ 配置 + 密钥
  if (staticMeta.kind === 'hubState') {
    const staticRoutes = [];
    for (const r of [
      'POST /api/auth/login',
      'GET /api/auth/verify',
      'POST /api/auth/logout',
      'GET /api/settings',
      'PUT /api/settings',
      'DELETE /api/settings',
      'GET /api/chat/state',
      'PUT /api/chat/config',
      'GET /api/chat/conversations',
      'POST /api/chat/conversations',
      'PUT /api/chat/conversations',
      'DELETE /api/chat/conversations',
      'POST /api/chat/models',
      'POST /api/chat/stream',
    ]) {
      const m = matchStaticRoute(...r.split(' '));
      const [, p] = r.split(' ');
      staticRoutes.push({
        method: m.key.split(' ')[0],
        path: p,
        builtIn: true,
        public: !!m.public,
        desc: '',
      });
    }
    const customRoutes = state.config.customRoutes.map((c) => ({
      id: c.id,
      method: c.method,
      path: c.path,
      builtIn: false,
      name: c.name,
      desc: c.desc,
      public: c.public,
    }));
    return sendJson(200, {
      routes: staticRoutes.concat(customRoutes),
      config: state.config,
      secrets: state.secrets,
      history: await hub.loadHistory(),
    });
  }

  // PUT /api/hub/config — 保存配置与密钥
  if (staticMeta.kind === 'hubConfig') {
    const body = await readJson(request);
    try {
      const saved = await hub.saveAll(body || {});
      return sendJson(200, { ok: true, config: saved.config, secrets: saved.secrets });
    } catch (e) {
      return sendJson(400, { error: 'bad_config', message: String((e && e.message) || e) });
    }
  }

  // PUT /api/hub/history — 保存请求运行历史
  if (staticMeta.kind === 'hubHistory') {
    const body = await readJson(request);
    try {
      const saved = await hub.saveHistory(body && body.history);
      return sendJson(200, { ok: true, history: saved });
    } catch (e) {
      return sendJson(400, { error: 'bad_history', message: String((e && e.message) || e) });
    }
  }

  // GET /api/auth/verify
  if (staticMeta.kind === 'verify') {
    return sendJson(200, { ok: true, expiry: session ? session.note : null });
  }

  // POST /api/auth/logout
  if (staticMeta.kind === 'logout') {
    const token = request.headers.get('x-auth-token');
    if (token) {
      await db.run('DELETE FROM auth_sessions WHERE token_hash = ?', [sha256(token)]);
    }
    return sendJson(200, { ok: true });
  }

  // GET /api/settings(保留键 settings:auth:* 不返回;敏感键解密后返回;
  // 返回全局注册表 + 指定/当前工作空间的设置)
  if (staticMeta.kind === 'getSettings') {
    const url = new URL(request.url);
    const requestedWs = url.searchParams.get('workspace') || '';
    let activeWs = requestedWs;
    if (!activeWs) {
      const row = await db.get(
        "SELECT value FROM app_settings WHERE workspace_id = ? AND key = 'settings:activeWorkspace'",
        [GLOBAL_WORKSPACE_ID]
      );
      activeWs = (row && row.value) || GLOBAL_WORKSPACE_ID;
    }
    const rows = await db.query(
      'SELECT workspace_id, key, value FROM app_settings WHERE workspace_id IN (?, ?) ORDER BY key',
      [GLOBAL_WORKSPACE_ID, activeWs]
    );
    const out = {};
    for (const r of rows) {
      if (r.key.indexOf(RESERVED_SETTINGS_PREFIX) === 0) continue;
      out[r.key] = isSensitiveKey(r.key) ? decrypt(r.value, env) || '' : r.value;
    }
    return sendJson(200, out);
  }

  // PUT /api/settings(按键归属作用域落库:全局键 → global,其余 → 当前工作空间)
  if (staticMeta.kind === 'putSettings') {
    const body = await readJson(request);
    const entries = body && typeof body.settings === 'object' ? body.settings : null;
    if (!entries) return sendJson(400, { error: 'bad_body', message: '需要 { settings: {...} }' });
    const keys = Object.keys(entries);
    for (const k of keys) {
      if (k.indexOf(RESERVED_SETTINGS_PREFIX) === 0) {
        return sendJson(403, { error: 'reserved_key', message: k + ' 为保留键,请走专用鉴权接口' });
      }
    }
    const declared =
      typeof entries['settings:activeWorkspace'] === 'string' && entries['settings:activeWorkspace']
        ? entries['settings:activeWorkspace']
        : '';
    let activeWs = declared;
    if (!activeWs) {
      const row = await db.get(
        "SELECT value FROM app_settings WHERE workspace_id = ? AND key = 'settings:activeWorkspace'",
        [GLOBAL_WORKSPACE_ID]
      );
      activeWs = (row && row.value) || GLOBAL_WORKSPACE_ID;
    }
    const now = new Date().toISOString();
    for (const k of keys) {
      const wsId = workspaceIdForKey(k, activeWs);
      let v = typeof entries[k] === 'string' ? entries[k] : JSON.stringify(entries[k]);
      // 敏感键:落库前加密,数据库不以明文存放
      if (isSensitiveKey(k)) v = encrypt(v, env);
      await db.run(
        'INSERT INTO app_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [wsId, k, v, now]
      );
    }
    return sendJson(200, { ok: true, written: keys.length });
  }

  // DELETE /api/settings(按当前/指定工作空间定位;全局键仍落在 global)
  if (staticMeta.kind === 'deleteSettings') {
    const body = await readJson(request);
    const keys = Array.isArray(body && body.keys) ? body.keys : [];
    const url = new URL(request.url);
    const requestedWs = url.searchParams.get('workspace') || '';
    let activeWs = requestedWs;
    if (!activeWs) {
      const row = await db.get(
        "SELECT value FROM app_settings WHERE workspace_id = ? AND key = 'settings:activeWorkspace'",
        [GLOBAL_WORKSPACE_ID]
      );
      activeWs = (row && row.value) || GLOBAL_WORKSPACE_ID;
    }
    for (const k of keys) {
      if (k.indexOf(RESERVED_SETTINGS_PREFIX) === 0) {
        return sendJson(403, { error: 'reserved_key', message: k + ' 为保留键' });
      }
      await db.run('DELETE FROM app_settings WHERE workspace_id = ? AND key = ?', [
        workspaceIdForKey(k, activeWs),
        k,
      ]);
    }
    return sendJson(200, { ok: true, removed: keys.length });
  }

  /* ---------- 聊天模块(配置/会话/模型/流式补全,与 Node 端共用 server/chat/index.js) ---------- */
  if (staticMeta.kind === 'chatState') {
    const loaded = await chat.loadAll();
    return sendJson(200, {
      config: loaded.config,
      secrets: loaded.secrets,
      conversations: await chat.listConversations(),
    });
  }
  if (staticMeta.kind === 'chatConfig') {
    const body = await readJson(request);
    try {
      const saved = await chat.saveAll(body || {});
      return sendJson(200, { ok: true, config: saved.config, secrets: saved.secrets });
    } catch (e) {
      return sendJson(400, { error: 'bad_config', message: String((e && e.message) || e) });
    }
  }
  if (staticMeta.kind === 'chatGetConversations') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '';
    if (id) return sendJson(200, { conversation: await chat.getConversation(id) });
    return sendJson(200, { conversations: await chat.listConversations() });
  }
  if (staticMeta.kind === 'chatPostConversation' || staticMeta.kind === 'chatPutConversation') {
    const body = await readJson(request);
    try {
      const conversation = await chat.upsertConversation(body && body.conversation);
      return sendJson(200, { conversation });
    } catch (e) {
      return sendJson(400, { error: 'bad_conversation', message: String((e && e.message) || e) });
    }
  }
  if (staticMeta.kind === 'chatDeleteConversations') {
    const body = await readJson(request);
    try {
      const result = await chat.deleteConversations(body && body.ids);
      return sendJson(200, { ok: true, removed: result.removed });
    } catch (e) {
      return sendJson(400, { error: 'bad_request', message: String((e && e.message) || e) });
    }
  }
  if (staticMeta.kind === 'chatModels') {
    const body = await readJson(request);
    try {
      const loaded = await chat.loadAll();
      const apiKey =
        body && typeof body.apiKey === 'string'
          ? body.apiKey
          : (loaded.secrets.providerKeys && loaded.secrets.providerKeys[body && body.providerId]) || '';
      const result = await chat.listModels(body && body.providerId, apiKey);
      return sendJson(200, { models: result.models });
    } catch (e) {
      return sendJson(400, { error: 'models_failed', message: String((e && e.message) || e) });
    }
  }
  if (staticMeta.kind === 'chatStream') {
    const body = await readJson(request);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (obj) => {
          try {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));
          } catch (e) {
            /* 已关闭 */
          }
        };
        try {
          await chat.streamChat(body || {}, {
            signal: request.signal || null,
            isAborted: () => request.signal ? request.signal.aborted : false,
            onEvent: enqueue,
          });
        } catch (e) {
          enqueue({ type: 'error', message: String((e && e.message) || e) });
        } finally {
          try {
            controller.close();
          } catch (e) {
            /* 已关闭 */
          }
        }
      },
    });
    return new Response(stream, {
      headers: Object.assign(
        {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
        },
        SECURITY_HEADERS
      ),
    });
  }

  return sendJson(404, { error: 'not_found' });
}

/* ---------- 入口 ---------- */
function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (isApiPath(url.pathname)) {
        const started = Date.now();
        const response = await handleApi(request, env, url.pathname);
        // 请求访问日志(配置驱动;失败绝不影响响应)
        try {
          const db = getDb(env);
          await boot(db);
          const hub = createHub({
            db,
            encrypt: (v) => encrypt(v, env),
            decrypt: (v) => decrypt(v, env),
            verifyPassword: (p) => verifyEnvPassword(p, env),
            matchesPassword,
          });
          const state = await hub.loadAll();
          if (hub.shouldLogRequest(request, url.pathname, state.config)) {
            await hub.appendLog(
              {
                method: request.method,
                path: url.pathname,
                status: response.status,
                ts: Date.now(),
                ip: clientIp(request),
                ua: String(request.headers.get('user-agent') || '').slice(0, 200),
                ms: Date.now() - started,
              },
              state.config
            );
          }
        } catch (e) {
          console.error('[worker] 请求日志落库失败: ' + ((e && e.message) || e));
        }
        return response;
      }
      // 非 API:透传给静态资源(assets 绑定);未命中资源时按 not_found_handling 处理
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error('[worker] 处理请求失败: ' + url.pathname + ' ' + ((e && e.stack) || e));
      return sendJson(500, { error: 'internal', message: '服务器内部错误' });
    }
  },
};
