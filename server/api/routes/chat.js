/* ============================================================
 * routes/chat.js — 聊天模块路由(工作空间隔离 + 流式补全代理)
 * ------------------------------------------------------------
 * GET    /api/chat/state            全量状态(配置 + 密钥 + 会话列表)
 * PUT    /api/chat/config           保存配置与密钥(密钥加密落库)
 * GET    /api/chat/conversations    会话列表(或 ?id= 取单个含消息)
 * POST   /api/chat/conversations    新建会话
 * PUT    /api/chat/conversations    保存/更新会话(upsert)
 * DELETE /api/chat/conversations    批量删除 { ids: [...] }
 * POST   /api/chat/models           获取供应商模型列表 { providerId }
 * POST   /api/chat/stream           流式补全(SSE,统一事件格式)
 *
 * 依赖由 server/api/index.js 注入 { db, encrypt, decrypt, chat }。
 * 除 stream 外均走 sendJson;stream 直接写 text/event-stream。
 * ============================================================ */
'use strict';

const { sendJson, readBody } = require('../../http/json');
const { SECURITY_HEADERS } = require('../../http/headers');

function chatRoutes({ db, encrypt, decrypt, chat }) {
  async function getState(req, res) {
    try {
      const { config, secrets } = await chat.loadAll();
      const conversations = await chat.listConversations();
      return sendJson(res, 200, { config, secrets, conversations });
    } catch (e) {
      return sendJson(res, 500, { error: 'internal', message: String((e && e.message) || e) });
    }
  }

  async function putConfig(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json' });
    }
    try {
      const saved = await chat.saveAll(body || {});
      return sendJson(res, 200, { ok: true, config: saved.config, secrets: saved.secrets });
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_config', message: String((e && e.message) || e) });
    }
  }

  async function getConversations(req, res) {
    let id = '';
    try {
      id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || '';
    } catch (e) {
      id = '';
    }
    try {
      if (id) {
        const conv = await chat.getConversation(id);
        return sendJson(res, 200, { conversation: conv });
      }
      const conversations = await chat.listConversations();
      return sendJson(res, 200, { conversations });
    } catch (e) {
      return sendJson(res, 500, { error: 'internal', message: String((e && e.message) || e) });
    }
  }

  async function postConversation(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json' });
    }
    try {
      const conv = await chat.upsertConversation(body && body.conversation);
      return sendJson(res, 200, { conversation: conv });
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_conversation', message: String((e && e.message) || e) });
    }
  }

  async function putConversation(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json' });
    }
    try {
      const conv = await chat.upsertConversation(body && body.conversation);
      return sendJson(res, 200, { conversation: conv });
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_conversation', message: String((e && e.message) || e) });
    }
  }

  async function deleteConversations(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json' });
    }
    try {
      const result = await chat.deleteConversations(body && body.ids);
      return sendJson(res, 200, { ok: true, removed: result.removed });
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_request', message: String((e && e.message) || e) });
    }
  }

  async function postModels(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json' });
    }
    try {
      const { secrets } = await chat.loadAll();
      const providerId = body && body.providerId;
      const apiKey =
        body && typeof body.apiKey === 'string'
          ? body.apiKey
          : (secrets.providerKeys && secrets.providerKeys[providerId]) || '';
      const result = await chat.listModels(providerId, apiKey);
      return sendJson(res, 200, { models: result.models });
    } catch (e) {
      return sendJson(res, 400, { error: 'models_failed', message: String((e && e.message) || e) });
    }
  }

  async function postStream(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json' });
    }
    res.writeHead(200, Object.assign(
      {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
      SECURITY_HEADERS
    ));
    const send = function (obj) {
      try {
        res.write('data: ' + JSON.stringify(obj) + '\n\n');
      } catch (e) {
        /* 客户端断开后写入失败,静默 */
      }
    };
    let aborted = false;
    req.on('close', function () {
      aborted = true;
    });
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const onAbort = function () {
      aborted = true;
      if (controller) controller.abort();
    };
    if (req && typeof req.on === 'function') {
      req.on('aborted', onAbort);
      req.on('close', onAbort);
    }
    try {
      await chat.streamChat(body || {}, {
        signal: controller ? controller.signal : null,
        isAborted: function () {
          return aborted;
        },
        onEvent: send,
      });
    } catch (e) {
      send({ type: 'error', message: String((e && e.message) || e) });
    }
    try {
      res.end();
    } catch (e) {
      /* 已断开 */
    }
  }

  return [
    { method: 'GET', path: '/api/chat/state', desc: '获取聊天全量状态(配置 + 密钥 + 会话列表)', handler: getState },
    { method: 'PUT', path: '/api/chat/config', desc: '保存聊天配置与密钥', handler: putConfig },
    { method: 'GET', path: '/api/chat/conversations', desc: '获取会话列表(或单个会话)', handler: getConversations },
    { method: 'POST', path: '/api/chat/conversations', desc: '新建会话', handler: postConversation },
    { method: 'PUT', path: '/api/chat/conversations', desc: '保存/更新会话', handler: putConversation },
    { method: 'DELETE', path: '/api/chat/conversations', desc: '批量删除会话', handler: deleteConversations },
    { method: 'POST', path: '/api/chat/models', desc: '获取供应商模型列表', handler: postModels },
    { method: 'POST', path: '/api/chat/stream', desc: '流式补全(SSE)', handler: postStream },
  ];
}

module.exports = chatRoutes;
