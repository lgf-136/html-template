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

test('chat: 新增端点 — 供应商目录 / 余额 / MCP 工具发现 / thinking max / 搜索条数钳制', async () => {
  // 供应商目录:含 baseUrl 与 keyUrl,内置测试供应商 opencode-go 可用
  const cat = await srv.request('GET', '/api/chat/providers', { token });
  assert.equal(cat.status, 200);
  assert.ok(Array.isArray(cat.json.providers));
  const oc = cat.json.providers.find((p) => p.id === 'opencode-go');
  assert.ok(oc);
  assert.equal(oc.baseUrl, 'https://opencode.ai/zen/go/v1');
  const deep = cat.json.providers.find((p) => p.id === 'deepseek');
  assert.ok(deep.keyUrl.length > 0);

  // thinking 支持 max 档位;searchResults 钳制到 3-15
  const cfg = {
    defaults: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'max',
      searchResults: 99,
      prompt: '你是测试助手',
    },
  };
  const put = await srv.request('PUT', '/api/chat/config', { token, body: { config: cfg, secrets: {} } });
  assert.equal(put.status, 200);
  assert.equal(put.json.config.defaults.thinking, 'max');
  assert.equal(put.json.config.defaults.searchResults, 15);
  assert.equal(put.json.config.defaults.prompt, '你是测试助手');

  // 余额:无 Key → 友好错误
  const balNoKey = await srv.request('POST', '/api/chat/balance', { token, body: { providerId: 'deepseek', apiKey: '' } });
  assert.equal(balNoKey.status, 400);
  assert.match(balNoKey.json.message, /API Key/);

  // 余额:不可达地址 → 快速失败并返回 400
  const badProvider = await srv.request('PUT', '/api/chat/config', {
    token,
    body: {
      config: {
        providers: [{ id: 'cust-bad', name: '坏地址', baseUrl: 'http://127.0.0.1:1/v1', kind: 'openai', models: [] }],
      },
      secrets: {},
    },
  });
  assert.equal(badProvider.status, 200);
  const balBad = await srv.request('POST', '/api/chat/balance', {
    token,
    body: { providerId: 'cust-bad', apiKey: 'sk-x' },
  });
  assert.equal(balBad.status, 400);

  // MCP 工具发现:不可达地址 → ok:false + error 字段
  const mcpTools = await srv.request('POST', '/api/chat/mcp/tools', {
    token,
    body: { url: 'http://127.0.0.1:1/mcp', protocol: 'https' },
  });
  assert.equal(mcpTools.status, 200);
  assert.equal(mcpTools.json.ok, false);
  assert.ok(mcpTools.json.error);
});

test('chat: 工具调用循环 — 跟进请求保留 function.name 与 arguments', async () => {
  // 回归:normalizeMessages 曾把 tool_calls 的 name/arguments 读在顶层,
  // 实际格式为 { id, type, function: { name, arguments } } → 跟进请求丢失字段,
  // 上游返回 500。用 mock fetch 完整跑一遍工具循环验证。
  const { createChat } = require('../../server/chat');

  function sseChunk(obj) {
    return 'data: ' + JSON.stringify(obj) + '\n\n';
  }
  function chunk(delta, finish) {
    return sseChunk({
      id: 'x1',
      object: 'chat.completion.chunk',
      model: 'mimo-v2.5',
      choices: [{ index: 0, finish_reason: finish || null, delta }],
    });
  }

  let providerCalls = 0;
  let followUpBody = null;
  let duckCalls = 0;

  const mockFetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('duckduckgo')) {
      duckCalls++;
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://x', snippet: 's' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    providerCalls++;
    const body = JSON.parse(opts.body);
    if (providerCalls === 1) {
      // 第一轮:流式返回工具调用(拆多个 chunk,模拟真实供应商)
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              chunk({ role: 'assistant', content: '', reasoning_content: null, tool_calls: null }) +
              chunk({ role: null, content: null, reasoning_content: '思考', tool_calls: null }) +
              chunk({ role: null, content: null, reasoning_content: null, tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'web_search', arguments: '' } }] }) +
              chunk({ role: null, content: null, reasoning_content: null, tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }) +
              chunk({ role: null, content: null, reasoning_content: null, tool_calls: [{ index: 0, function: { arguments: ' "2026"}' } }] }),
              { role: null, content: null, reasoning_content: null, tool_calls: null },
              'tool_calls'
            )
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    // 第二轮:校验跟进请求结构后返回最终文本
    followUpBody = body;
    const asst = body.messages.find((m) => m.tool_calls);
    assert.ok(asst, '跟进请求应包含 assistant tool_calls');
    assert.equal(asst.tool_calls[0].function.name, 'web_search', '跟进请求应保留 function.name');
    assert.equal(asst.tool_calls[0].function.arguments, '{"query": "2026"}', '跟进请求应保留完整 arguments');
    assert.equal(asst.tool_calls[0].id, 'call_abc');
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '应包含 tool 结果消息');
    assert.equal(toolMsg.tool_call_id, 'call_abc');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk({ role: 'assistant', content: '搜索完成:', reasoning_content: null, tool_calls: null })));
        controller.enqueue(new TextEncoder().encode(chunk({ role: null, content: '洛杉矶', reasoning_content: null, tool_calls: null })));
        controller.enqueue(new TextEncoder().encode(sseChunk({ id: 'x2', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const chat = createChat({
    db: { query: async () => [], get: async () => null, run: async () => ({ changes: 1 }) },
    encrypt: (v) => v,
    decrypt: (v) => v,
    fetchImpl: mockFetch,
  });

  const events = [];
  const out = await chat.streamChat(
    {
      provider: 'opencode-go',
      model: 'mimo-v2.5',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: '搜索 2026 年奥运会' }],
      thinking: 'none',
      params: { temperature: 0.2, maxTokens: 1024 },
      webSearch: true,
      webSearchProvider: 'duckduckgo',
      mcpEnabled: false,
    },
    { onEvent: (ev) => events.push(ev) }
  );
  assert.equal(providerCalls, 2, '应恰好两次上游请求');
  assert.equal(duckCalls, 1, '应触发一次搜索');
  assert.equal((out.text || '').trim(), '搜索完成:洛杉矶');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('tool_start') && types.includes('tool_result') && types.includes('done'));
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
