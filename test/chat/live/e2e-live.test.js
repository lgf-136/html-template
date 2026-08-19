/* ============================================================
 * chat 模块 — 真实供应商端到端验证(可选运行,需外网 + Key)
 * ------------------------------------------------------------
 * 使用测试供应商 opencode-go / mimo-v2.5,验证:
 *   - 流式输出 + 思维链(start → thinking → delta → done)
 *   - 多模态图片输入
 *   - 联网搜索工具调用循环(web_search → tool_result → 最终回答)
 * 运行: TEST_OPENCODE_KEY=sk-... node --test test/chat/live/e2e-live.test.js
 * 未设置 TEST_OPENCODE_KEY 时整体跳过(不计失败)。
 * ============================================================ */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const API_KEY = process.env.TEST_OPENCODE_KEY;
if (!API_KEY) {
  test('live: 未设置 TEST_OPENCODE_KEY,跳过真实供应商测试', () => {
    assert.ok(true);
  });
} else {
  test('live: opencode-go mimo-v2.5 流式输出 + 思维链', { timeout: 60000 }, async () => {
    const { createChat } = require('../../../server/chat');
    const chat = createChat({
      db: {
        query: async () => [],
        get: async () => null,
        run: async () => ({ changes: 1, lastInsertRowid: 1 }),
      },
      encrypt: (v) => v,
      decrypt: (v) => v,
    });

    const events = [];
    const out = await chat.streamChat(
      {
        provider: 'opencode-go',
        model: 'mimo-v2.5',
        apiKey: API_KEY,
        messages: [{ role: 'user', content: '只回复两个字:你好' }],
        thinking: 'medium',
        params: { temperature: 0.7, topP: 1, maxTokens: 2048 },
        webSearch: false,
        mcpEnabled: false,
      },
      { onEvent: (ev) => events.push(ev) }
    );

    assert.ok(out, 'streamChat 应返回结果');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('start'), '应有 start 事件,实际: ' + types.join(','));
    assert.ok(types.includes('delta') || types.includes('text'), '应有内容增量事件,实际: ' + types.join(','));
    assert.ok(types.includes('done'), '应有 done 事件,实际: ' + types.join(','));
    const text = (out.text || '').trim();
    assert.ok(text.length > 0, '应输出文本,实际: ' + JSON.stringify(text));
    console.log('  文本:', JSON.stringify(text.slice(0, 120)));
    console.log('  事件:', types.join(','));
  });

  test('live: 多模态图片输入(mimo-v2.5)', { timeout: 60000 }, async () => {
    const { createChat } = require('../../../server/chat');
    const chat = createChat({
      db: { query: async () => [], get: async () => null, run: async () => ({ changes: 1 }) },
      encrypt: (v) => v,
      decrypt: (v) => v,
    });
    // 1x1 红色 PNG(data URL)
    const png =
      'data:image/png;base64,' +
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const events = [];
    const out = await chat.streamChat(
      {
        provider: 'opencode-go',
        model: 'mimo-v2.5',
        apiKey: API_KEY,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图片是什么颜色?只回答颜色名' },
              { type: 'image_url', image_url: { url: png } },
            ],
          },
        ],
        thinking: 'none',
        params: { temperature: 0.2, maxTokens: 1024 },
        webSearch: false,
        mcpEnabled: false,
      },
      { onEvent: (ev) => events.push(ev) }
    );
    const text = (out.text || '').trim();
    assert.ok(text.length > 0, '多模态应输出文本,实际: ' + JSON.stringify(text));
    assert.ok(/红|red/i.test(text), '应识别红色,实际: ' + JSON.stringify(text));
    console.log('  多模态回答:', JSON.stringify(text.slice(0, 120)));
  });

  test('live: 联网搜索工具(duckduckgo,无 Key)', { timeout: 90000 }, async () => {
    const { createChat } = require('../../../server/chat');
    const chat = createChat({
      db: { query: async () => [], get: async () => null, run: async () => ({ changes: 1 }) },
      encrypt: (v) => v,
      decrypt: (v) => v,
    });
    const events = [];
    const out = await chat.streamChat(
      {
        provider: 'opencode-go',
        model: 'mimo-v2.5',
        apiKey: API_KEY,
        messages: [{ role: 'user', content: '搜索 2026 年奥运会举办城市,一句话回答' }],
        thinking: 'none',
        params: { temperature: 0.2, maxTokens: 1024 },
        webSearch: true,
        webSearchProvider: 'duckduckgo',
        mcpEnabled: false,
      },
      { onEvent: (ev) => events.push(ev) }
    );
    const types = events.map((e) => e.type);
    console.log('  事件:', types.join(','));
    assert.ok(types.includes('tool_start'), '应触发工具调用,实际: ' + types.join(','));
    assert.ok(types.includes('tool_result'), '应返回工具结果,实际: ' + types.join(','));
    assert.ok((out.text || '').trim().length > 0, '搜索后应输出回答');
    console.log('  搜索回答:', JSON.stringify((out.text || '').slice(0, 120)));
  });
}
