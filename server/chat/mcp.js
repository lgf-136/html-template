/* ============================================================
 * chat/mcp.js — MCP (Model Context Protocol) 客户端(零依赖)
 * ------------------------------------------------------------
 * 支持两种传输协议(与右侧栏「MCP」页的协议下拉对应):
 *   https   streamable HTTP(MCP 现行标准):POST JSON-RPC 2.0,
 *           响应为 JSON 或 SSE;会话经 Mcp-Session-Id 维持
 *   sse     legacy HTTP+SSE:先 GET 建立 SSE 流取得 endpoint,
 *           再 POST JSON-RPC 到 endpoint,响应经 SSE 流回传
 *
 * 仅暴露两个方法:
 *   listTools(server)  → { ok, tools:[{name, description, inputSchema}], error }
 *   callTool(server, name, args) → { ok, result, error }
 * server 形状: { url, protocol:'https'|'sse', headers?: object }
 * ============================================================ */
'use strict';

/* ---------- 通用 SSE 解析 ---------- */
function createSseParser() {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
    },
    /** 取出完整事件数组;一个事件可能跨多行 data */
    drain() {
      const out = [];
      let idx;
      // 事件以空行分隔;先按 \n\n 切(兼容 \r\n)
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + (buf.slice(idx).match(/^\r?\n\r?\n/) || ['\n\n'])[0].length);
        const ev = { event: 'message', data: '', id: null };
        raw.split(/\r?\n/).forEach(function (line) {
          if (line.indexOf('event:') === 0) ev.event = line.slice(6).trim();
          else if (line.indexOf('id:') === 0) ev.id = line.slice(3).trim();
          else if (line.indexOf('data:') === 0) {
            const d = line.slice(5);
            ev.data += (ev.data ? '\n' : '') + (d.charAt(0) === ' ' ? d.slice(1) : d);
          }
        });
        if (ev.data) out.push(ev);
      }
      return out;
    },
  };
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

function resolveUrl(base, path) {
  try {
    return new URL(path, base).toString();
  } catch (e) {
    return path;
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const v = headers[name.toLowerCase()];
  return v === undefined ? headers[name] : v;
}

/** 从 fetch Response 读取全部文本(兼容 Web stream / 直接 text) */
async function readAllText(res) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
    }
    return chunks.join('');
  }
  return res.text();
}

/* ---------- Streamable HTTP(https) ---------- */
async function httpTransport(fetchImpl, server, method, params) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    server.headers || {}
  );
  const res = await fetchImpl(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const sessionId = getHeader(res.headers, 'mcp-session-id') || getHeader(res.headers, 'Mcp-Session-Id');
  const ctype = String(getHeader(res.headers, 'content-type') || '');
  let payload = null;
  if (ctype.indexOf('text/event-stream') !== -1) {
    // streamable HTTP 也可能以 SSE 返回 JSON-RPC 消息
    const text = await readAllText(res);
    const parser = createSseParser();
    parser.feed(text);
    const events = parser.drain();
    for (const ev of events) {
      const obj = parseJson(ev.data, null);
      if (obj && obj.method == null && obj.id != null) payload = obj;
    }
  } else {
    payload = parseJson(await readAllText(res), null);
  }
  if (!payload) {
    const bodyText = await readAllText(res).catch(function () {
      return '';
    });
    payload = parseJson(bodyText, null);
  }
  if (payload && payload.error) {
    const err = new Error(payload.error.message || 'MCP error');
    err.code = payload.error.code;
    throw err;
  }
  return { payload, sessionId };
}

/* ---------- Legacy HTTP+SSE(sse) ---------- */
function sseTransport(fetchImpl, server) {
  let endpoint = null;
  let reader = null;
  let ended = false;
  const pending = {}; // id -> resolve
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let endpointReady = null;
  const endpointPromise = new Promise(function (resolve) {
    endpointReady = resolve;
  });

  async function pump() {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        Object.keys(pending).forEach(function (id) {
          pending[id]({ error: { code: -32000, message: 'MCP SSE 流已关闭' } });
          delete pending[id];
        });
        break;
      }
      const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      parser.feed(chunk);
      const events = parser.drain();
      for (const ev of events) {
        if (ev.event === 'endpoint') {
          if (!endpoint) {
            endpoint = resolveUrl(server.url, ev.data);
            endpointReady(endpoint);
          }
          continue;
        }
        const obj = parseJson(ev.data, null);
        if (obj && obj.id != null && pending[obj.id]) {
          pending[obj.id](obj);
          delete pending[obj.id];
        }
      }
    }
  }

  async function connect() {
    const res = await fetchImpl(server.url, {
      headers: Object.assign({ Accept: 'text/event-stream' }, server.headers || {}),
    });
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('MCP SSE 端点无流式响应');
    }
    reader = res.body.getReader();
    pump();
  }

  async function request(method, params, id) {
    if (!endpoint) {
      // 等待 endpoint 事件(最多 10s)
      const timeout = new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('等待 MCP endpoint 超时'));
        }, 10000);
      });
      await Promise.race([endpointPromise, timeout]);
    }
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, server.headers || {}),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    // 某些实现直接在 POST 响应中回 JSON-RPC(兼容处理)
    const ctype = String(getHeader(res.headers, 'content-type') || '');
    if (ctype.indexOf('application/json') !== -1) {
      const obj = parseJson(await readAllText(res), null);
      if (obj && obj.id != null) return obj;
    }
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('MCP 请求响应超时'));
        }
      }, 120000);
      pending[id] = function (obj) {
        clearTimeout(timer);
        if (obj && obj.error) {
          const err = new Error(obj.error.message || 'MCP error');
          err.code = obj.error.code;
          reject(err);
        } else resolve(obj);
      };
    });
  }

  return { connect, request, isEnded: function () { return ended; } };
}

/* ---------- 客户端门面 ---------- */
function createMcpClient(deps) {
  const fetchImpl = (deps && deps.fetchImpl) || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('MCP 客户端需要 fetch 实现');

  async function initHttps(server) {
    const { payload, sessionId } = await httpTransport(fetchImpl, server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'freebuff-chat', version: '1.0.0' },
    });
    return sessionId;
  }

  async function withInitialized(server, work) {
    if (server.protocol === 'sse') {
      const t = sseTransport(fetchImpl, server);
      await t.connect();
      try {
        await t.request('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'freebuff-chat', version: '1.0.0' },
        }, 0);
        return await work(t);
      } finally {
        /* SSE 连接随请求结束而释放(无显式 close API) */
      }
    }
    // https:初始化拿 session id,后续请求带上
    const sessionId = await initHttps(server);
    const headers = Object.assign({}, server.headers || {});
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const bound = { protocol: 'https', url: server.url, headers };
    return work(bound);
  }

  function listTools(server) {
    return withInitialized(server, async function (t) {
      let resp;
      if (server.protocol === 'sse') {
        resp = await t.request('tools/list', {}, 1);
      } else {
        resp = (await httpTransport(fetchImpl, t, 'tools/list', {})).payload;
      }
      return {
        ok: true,
        tools: (resp && resp.result && resp.result.tools) || [],
      };
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : 'MCP tools/list 失败', tools: [] };
    });
  }

  function callTool(server, name, args) {
    return withInitialized(server, async function (t) {
      let resp;
      if (server.protocol === 'sse') {
        resp = await t.request('tools/call', { name, arguments: args || {} }, 2);
      } else {
        resp = (await httpTransport(fetchImpl, t, 'tools/call', { name, arguments: args || {} })).payload;
      }
      const result = resp && resp.result;
      const content = (result && result.content) || [];
      let text = '';
      content.forEach(function (block) {
        if (!block) return;
        if (block.type === 'text') text += (text ? '\n' : '') + String(block.text == null ? '' : block.text);
        else if (block.type === 'image') text += (text ? '\n' : '') + '[image: ' + (block.mimeType || 'image') + ']';
        else text += (text ? '\n' : '') + JSON.stringify(block);
      });
      return { ok: !result.isError, result: text, raw: result, error: result.isError ? text : null };
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : 'MCP tools/call 失败', result: '' };
    });
  }

  return { listTools, callTool };
}

module.exports = { createMcpClient, createSseParser };
