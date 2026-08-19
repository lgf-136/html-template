/* ============================================================
 * chat 模块后端测试
 * ------------------------------------------------------------
 * 覆盖:全量状态、配置 + 密钥往返(密钥加密落库)、会话 CRUD
 * (列表预览 / 单个含消息 / 置顶收藏存档 / 批量删除)、
 * 工作空间隔离。
 * ============================================================ */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/server');

let srv;
let token;

before(async () => {
  srv = await startServer();
  const login = await srv.login();
  assert.equal(login.status, 200);
  token = login.json.token;
});

after(async () => {
  await srv.stop();
});

test('chat: 全量状态返回默认配置(内置提示词 + 供应商默认值)', async () => {
  const r = await srv.request('GET', '/api/chat/state', { token });
  assert.equal(r.status, 200);
  assert.ok(r.json.config);
  assert.ok(Array.isArray(r.json.config.prompts));
  assert.ok(r.json.config.prompts.length >= 5);
  assert.equal(r.json.config.defaults.provider, 'opencode-go');
  assert.ok(Array.isArray(r.json.conversations));
  assert.ok(r.json.secrets && typeof r.json.secrets === 'object');
});

test('chat: 配置 + 密钥往返,密钥加密落库', async () => {
  const config = {
    groups: [{ id: 'g1', name: '工作', sort: 0 }],
    tags: [{ id: 't1', name: '重要', color: '#ef4444' }],
    defaults: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    mcp: [
      {
        id: 'mcp1',
        name: '测试 MCP',
        url: 'https://example.com/mcp',
        protocol: 'https',
        enabled: true,
        tools: [{ name: 'ping', description: '测试工具', enabled: true }],
      },
    ],
  };
  const secrets = { providerKeys: { deepseek: 'sk-test-secret-123' } };
  const put = await srv.request('PUT', '/api/chat/config', { token, body: { config, secrets } });
  assert.equal(put.status, 200);
  assert.equal(put.json.config.defaults.model, 'deepseek-v4-flash');
  assert.equal(put.json.secrets.providerKeys.deepseek, 'sk-test-secret-123');

  const state = await srv.request('GET', '/api/chat/state', { token });
  assert.equal(state.json.config.groups[0].name, '工作');
  assert.equal(state.json.config.mcp[0].tools[0].name, 'ping');
  assert.equal(state.json.secrets.providerKeys.deepseek, 'sk-test-secret-123');

  // 密钥落库为 AES-256-GCM 密文,非明文
  const rawSecrets = srv.readChatConfig('secrets');
  assert.ok(rawSecrets.indexOf('enc:v1:') === 0);
  assert.ok(rawSecrets.indexOf('sk-test-secret-123') === -1);
});

test('chat: 会话创建 / 列表预览 / 单个读取 / 更新 / 删除', async () => {
  // 创建
  const create = await srv.request('POST', '/api/chat/conversations', {
    token,
    body: {
      conversation: {
        id: 'conv-1',
        title: '测试会话',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好!有什么可以帮你?' },
        ],
      },
    },
  });
  assert.equal(create.status, 200);
  assert.equal(create.json.conversation.id, 'conv-1');

  // 列表:带预览,不含全量消息
  const list = await srv.request('GET', '/api/chat/conversations', { token });
  assert.equal(list.status, 200);
  const item = list.json.conversations.find((c) => c.id === 'conv-1');
  assert.ok(item);
  assert.equal(item.preview, '你好!有什么可以帮你?');
  assert.equal(item.messageCount, 2);
  assert.equal(item.messages, undefined);

  // 单个:含全量消息
  const one = await srv.request('GET', '/api/chat/conversations?id=conv-1', { token });
  assert.equal(one.status, 200);
  assert.equal(one.json.conversation.messages.length, 2);

  // 更新:置顶 + 收藏 + 存档
  const upd = await srv.request('PUT', '/api/chat/conversations', {
    token,
    body: { conversation: { id: 'conv-1', title: '改名', pinned: true, favorite: true, archived: true } },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.conversation.title, '改名');
  assert.equal(upd.json.conversation.pinned, true);
  assert.equal(upd.json.conversation.messages.length, 2); // 未提供 messages 时保留原值

  // 批量删除
  const del = await srv.request('DELETE', '/api/chat/conversations', { token, body: { ids: ['conv-1'] } });
  assert.equal(del.status, 200);
  assert.equal(del.json.removed, 1);

  const list2 = await srv.request('GET', '/api/chat/conversations', { token });
  assert.equal(list2.json.conversations.some((c) => c.id === 'conv-1'), false);
});

test('chat: 会话数据按工作空间隔离', async () => {
  await srv.request('POST', '/api/chat/conversations', {
    token,
    body: { conversation: { id: 'conv-ws', title: '默认空间会话' } },
  });

  // 切到新工作空间 ws-chat-test
  const switchWs = await srv.request('PUT', '/api/settings', {
    token,
    body: { settings: { 'settings:activeWorkspace': 'ws-chat-test' } },
  });
  assert.equal(switchWs.status, 200);

  const list2 = await srv.request('GET', '/api/chat/conversations', { token });
  assert.equal(list2.json.conversations.some((c) => c.id === 'conv-ws'), false);

  // 切回默认工作空间
  await srv.request('PUT', '/api/settings', {
    token,
    body: { settings: { 'settings:activeWorkspace': 'ws-default' } },
  });
  const list3 = await srv.request('GET', '/api/chat/conversations', { token });
  assert.equal(list3.json.conversations.some((c) => c.id === 'conv-ws'), true);

  // 清理
  await srv.request('DELETE', '/api/chat/conversations', { token, body: { ids: ['conv-ws'] } });
});
