/* ============================================================
 * chat/index.js — 聊天模块核心(配置/会话存取 + 大模型流式代理,Node / Worker 共用)
 * ------------------------------------------------------------
 * 职责:
 *   1. 存取聊天配置与密钥(chat_config 表:config 明文 / secrets 加密落库,
 *      按 workspace_id 隔离;供应商 API Key 与搜索 Key 均加密)
 *   2. 会话 CRUD(chat_conversations 表,消息以 JSON 内嵌,按工作空间隔离)
 *   3. 供应商解析(内置目录 + 用户自定义,兼容 OpenAI chat/completions;
 *      Anthropic 走原生 Messages API,自动做消息/工具格式翻译)
 *   4. 流式补全代理:统一 SSE 事件格式输出,支持思维链 / 工具调用循环
 *      (MCP 工具 + 内置联网搜索工具),工具调用成功/失败状态透传前端
 *
 * 运行时无关:
 *   - fetchImpl 由注入提供(缺省回退全局 fetch),返回 Web Response;
 *   - 上游响应体经 body.getReader() 读取,Node ≥18 / Worker / Deno 通用。
 * 统一 SSE 事件(每行 data: <json>):
 *   {type:'start'} {type:'delta',text} {type:'thinking',text}
 *   {type:'tool_start',id,name} {type:'tool_arg',id,text}
 *   {type:'tool_end',id,name,args}
 *   {type:'tool_result',id,name,ok,output,error}
 *   {type:'done',finishReason,usage} {type:'error',message}
 * ============================================================ */
'use strict';

const { GLOBAL_WORKSPACE_ID } = require('../db/scope');
const { providerById } = require('./providers');
const { createMcpClient } = require('./mcp');
const { webSearch } = require('./search');

const DEFAULT_WORKSPACE_ID = 'ws-default';
const MAX_TOOL_LOOPS = 8;

/* ---------- 内置提示词 ---------- */
const BUILTIN_PROMPTS = [
  { id: 'p-translator', name: '翻译家', content: '你是一位资深翻译家,把用户输入准确、自然地翻译成目标语言。若未指定目标语言,默认译为英文。只输出译文,不要多余解释。' },
  { id: 'p-mathematician', name: '数学家', content: '你是一位严谨的数学家,逐步推理并给出简洁证明或计算过程,最终给出明确答案。' },
  { id: 'p-react', name: 'React 工程师', content: '你是一位资深 React 前端工程师,精通 React、TypeScript、Hooks 与工程最佳实践。回答要给出可直接运行的代码,并说明关键设计。' },
  { id: 'p-python', name: 'Python 专家', content: '你是一位资深 Python 工程师,代码遵循 PEP8,优先使用标准库与可维护的写法。' },
  { id: 'p-code-review', name: '代码审查员', content: '你是一位严格的代码审查员,指出 bug、性能、可维护性与安全问题,并给出修改建议。' },
  { id: 'p-writer', name: '写作助手', content: '你是一位专业写作者,文笔清晰、结构严谨,根据用户要求完成写作并主动润色。' },
  { id: 'p-sql', name: 'SQL 专家', content: '你是一位数据库专家,写出正确、高效、可读的 SQL,并解释执行计划与索引建议。' },
  { id: 'p-explain', name: '通俗解释者', content: '用通俗易懂、循序渐进的方式解释复杂概念,适当使用类比,让新手也能理解。' },
  { id: 'p-default', name: '通用助手', content: '你是一位乐于助人的 AI 助手,回答准确、简洁、有条理。' },
];

/* ---------- 默认配置 ---------- */
function defaultConfig() {
  return {
    version: 1,
    groups: [],
    tags: [],
    providers: [], // 用户自定义供应商(openai 兼容)
    defaults: {
      provider: 'opencode-go',
      model: 'mimo-v2.5',
      promptId: '',
      params: { temperature: 0.7, topP: 1, topK: 0, maxTokens: 8192, presencePenalty: 0, frequencyPenalty: 0 },
      thinking: 'none', // none / low / medium / high
      webSearch: false,
      webSearchProvider: 'duckduckgo',
      mcpEnabled: true,
    },
    prompts: BUILTIN_PROMPTS.map(function (p) {
      return Object.assign({}, p);
    }),
    mcp: [],
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

function validId(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));
}

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/* ============================================================
 * createChat
 * ============================================================ */
function createChat(deps) {
  const { db, encrypt, decrypt } = deps;
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('chat 需要 fetch 实现');
  const mcp = createMcpClient({ fetchImpl });

  async function resolveWorkspace() {
    const row = await db.get(
      "SELECT value FROM app_settings WHERE workspace_id = ? AND key = 'settings:activeWorkspace'",
      [GLOBAL_WORKSPACE_ID]
    );
    return (row && row.value) || DEFAULT_WORKSPACE_ID;
  }

  /* ---------- 配置存取 ---------- */
  function normalizeConfig(input) {
    const cfg = defaultConfig();
    if (!isPlainObject(input)) return cfg;

    if (Array.isArray(input.groups)) {
      cfg.groups = input.groups
        .filter(function (g) { return isPlainObject(g) && validId(g.id) && typeof g.name === 'string' && g.name.trim(); })
        .map(function (g) {
          return {
            id: String(g.id),
            name: String(g.name).trim().slice(0, 50),
            parentId: validId(g.parentId) ? String(g.parentId) : '',
            sort: Number(g.sort) || 0,
            color: typeof g.color === 'string' ? String(g.color).slice(0, 24) : '',
            icon: typeof g.icon === 'string' ? String(g.icon).slice(0, 16) : '',
          };
        });
    }
    if (Array.isArray(input.tags)) {
      cfg.tags = input.tags
        .filter(function (t) { return isPlainObject(t) && validId(t.id) && typeof t.name === 'string' && t.name.trim(); })
        .map(function (t) {
          return {
            id: String(t.id),
            name: String(t.name).trim().slice(0, 40),
            color: typeof t.color === 'string' ? String(t.color).slice(0, 24) : '',
            sort: Number(t.sort) || 0,
          };
        });
    }
    if (Array.isArray(input.providers)) {
      cfg.providers = input.providers
        .filter(function (p) { return isPlainObject(p) && validId(p.id) && typeof p.name === 'string' && p.name.trim(); })
        .map(function (p) {
          return {
            id: String(p.id),
            name: String(p.name).trim().slice(0, 50),
            baseUrl: typeof p.baseUrl === 'string' ? String(p.baseUrl).trim().slice(0, 300) : '',
            kind: p.kind === 'anthropic' ? 'anthropic' : 'openai',
            models: Array.isArray(p.models) ? p.models.map(String).slice(0, 200) : [],
            multimodal: !!p.multimodal,
          };
        });
    }
    if (isPlainObject(input.defaults)) {
      const d = input.defaults;
      if (typeof d.provider === 'string') cfg.defaults.provider = d.provider;
      if (typeof d.model === 'string') cfg.defaults.model = d.model;
      if (typeof d.promptId === 'string') cfg.defaults.promptId = d.promptId;
      if (typeof d.webSearchProvider === 'string') cfg.defaults.webSearchProvider = d.webSearchProvider;
      cfg.defaults.webSearch = !!d.webSearch;
      cfg.defaults.mcpEnabled = d.mcpEnabled !== false;
      if (['none', 'low', 'medium', 'high'].indexOf(d.thinking) !== -1) cfg.defaults.thinking = d.thinking;
      if (isPlainObject(d.params)) {
        const p = d.params;
        cfg.defaults.params = {
          temperature: clampNum(p.temperature, 0, 2, 0.7),
          topP: clampNum(p.topP, 0, 1, 1),
          topK: clampNum(p.topK, 0, 1000, 0),
          maxTokens: clampNum(p.maxTokens, 1, 2000000, 8192),
          presencePenalty: clampNum(p.presencePenalty, -2, 2, 0),
          frequencyPenalty: clampNum(p.frequencyPenalty, -2, 2, 0),
        };
      }
    }
    if (Array.isArray(input.prompts)) {
      cfg.prompts = input.prompts
        .filter(function (p) { return isPlainObject(p) && validId(p.id) && typeof p.name === 'string' && p.name.trim(); })
        .map(function (p) {
          return {
            id: String(p.id),
            name: String(p.name).trim().slice(0, 40),
            content: typeof p.content === 'string' ? p.content.slice(0, 4000) : '',
            sort: Number(p.sort) || 0,
          };
        });
    }
    if (Array.isArray(input.mcp)) {
      cfg.mcp = input.mcp
        .filter(function (s) { return isPlainObject(s) && validId(s.id) && typeof s.url === 'string' && s.url.trim(); })
        .map(function (s) {
          return {
            id: String(s.id),
            name: typeof s.name === 'string' ? s.name.trim().slice(0, 50) : s.id,
            url: String(s.url).trim().slice(0, 300),
            protocol: s.protocol === 'sse' ? 'sse' : 'https',
            enabled: !!s.enabled,
            headers: isPlainObject(s.headers) ? s.headers : undefined,
            tools: Array.isArray(s.tools)
              ? s.tools.map(function (t) {
                  return {
                    name: typeof t.name === 'string' ? t.name : '',
                    description: typeof t.description === 'string' ? t.description : '',
                    enabled: t.enabled !== false,
                  };
                })
              : [],
          };
        });
    }
    return cfg;
  }

  async function loadAll() {
    const ws = await resolveWorkspace();
    const row = await db.get('SELECT config, secrets FROM chat_config WHERE workspace_id = ?', [ws]);
    let config = parseJson(row && row.config, null);
    if (!isPlainObject(config)) config = defaultConfig();
    config = normalizeConfig(config);
    let secrets = row && row.secrets ? parseJson(decrypt(row.secrets), {}) : {};
    if (!isPlainObject(secrets)) secrets = {};
    if (!isPlainObject(secrets.providerKeys)) secrets.providerKeys = {};
    if (!isPlainObject(secrets.searchKeys)) secrets.searchKeys = {};
    return { config, secrets };
  }

  async function saveAll(payload) {
    if (!isPlainObject(payload)) throw new Error('需要 { config, secrets }');
    const config = normalizeConfig(payload.config);
    const secrets = isPlainObject(payload.secrets) ? payload.secrets : {};
    const providerKeys = isPlainObject(secrets.providerKeys) ? secrets.providerKeys : {};
    const searchKeys = isPlainObject(secrets.searchKeys) ? secrets.searchKeys : {};
    const cleanProviderKeys = {};
    Object.keys(providerKeys).forEach(function (k) {
      if (typeof providerKeys[k] === 'string' && providerKeys[k]) cleanProviderKeys[k] = providerKeys[k].slice(0, 512);
    });
    const cleanSearchKeys = {};
    Object.keys(searchKeys).forEach(function (k) {
      if (typeof searchKeys[k] === 'string' && searchKeys[k]) cleanSearchKeys[k] = searchKeys[k].slice(0, 512);
    });
    const cleanSecrets = { providerKeys: cleanProviderKeys, searchKeys: cleanSearchKeys };
    const ws = await resolveWorkspace();
    await db.run(
      'INSERT INTO chat_config (workspace_id, config, secrets, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config = excluded.config, secrets = excluded.secrets, updated_at = excluded.updated_at',
      [ws, JSON.stringify(config), encrypt(JSON.stringify(cleanSecrets)), new Date().toISOString()]
    );
    return { config, secrets: cleanSecrets };
  }

  /* ---------- 供应商解析 ---------- */
  function resolveProvider(config, providerId) {
    const builtin = providerById(providerId);
    if (builtin) return builtin;
    const customs = config.providers || [];
    for (let i = 0; i < customs.length; i++) {
      if (customs[i].id === providerId) return customs[i];
    }
    return null;
  }

  /** 归一化消息为 OpenAI 兼容格式(客户端已按 OpenAI content parts 组装) */
  function normalizeMessages(messages) {
    const out = [];
    (messages || []).forEach(function (m) {
      if (!isPlainObject(m) || !m.role) return;
      const role = m.role;
      let content = m.content;
      if (typeof content !== 'string' && !Array.isArray(content)) content = String(content == null ? '' : content);
      // 跳过客户端流式前的空占位助手消息(无内容且无工具调用),避免污染上游请求
      if (role === 'assistant' && !Array.isArray(m.tool_calls) && typeof content === 'string' && content.trim() === '') {
        return;
      }
      const item = { role: role, content: content };
      if (role === 'assistant' && Array.isArray(m.tool_calls)) {
        item.tool_calls = m.tool_calls.map(function (tc) {
          return {
            id: tc.id || uid('call'),
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
          };
        });
        if (item.content === '') item.content = null;
      }
      if (role === 'tool') {
        item.tool_call_id = m.tool_call_id || m.toolCallId || '';
        item.content = typeof content === 'string' ? content : JSON.stringify(content);
      }
      out.push(item);
    });
    return out;
  }

  /* ---------- 模型列表 ---------- */
  async function listModels(providerId, apiKey) {
    const { config } = await loadAll();
    const provider = resolveProvider(config, providerId);
    if (!provider) throw new Error('未知供应商: ' + providerId);
    const key = apiKey || '';
    let url = (provider.baseUrl || '').replace(/\/+$/, '');
    const headers = {};
    if (provider.kind === 'anthropic') {
      url += '/models';
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      url += '/models';
      if (key) headers['Authorization'] = 'Bearer ' + key;
    }
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(function () { return ''; });
      let msg = text;
      try { msg = (JSON.parse(text) && JSON.parse(text).error && JSON.parse(text).error.message) || text; } catch (e) { /* ignore */ }
      throw new Error('获取模型列表失败(' + res.status + '): ' + String(msg || '').slice(0, 200));
    }
    const data = await res.json();
    const list = (data && data.data) || [];
    const models = list
      .map(function (m) { return String(m.id || m.name || ''); })
      .filter(Boolean)
      .sort();
    return { providerId, models };
  }

  /* ============================================================
   * 流式补全(统一 SSE)
   * ============================================================ */

  function thinkingBudget(level) {
    if (level === 'low') return 1024;
    if (level === 'medium') return 4096;
    if (level === 'high') return 8192;
    return 0;
  }

  /** OpenAI 兼容请求体 */
  function buildOpenAIBody(o) {
    const body = { model: o.model, messages: normalizeMessages(o.messages), stream: true };
    const p = o.params || {};
    if (p.temperature != null && p.temperature !== '') body.temperature = Number(p.temperature);
    if (p.topP != null && p.topP !== '') body.top_p = Number(p.topP);
    if (p.topK != null && Number(p.topK) > 0) body.top_k = Number(p.topK);
    if (p.maxTokens != null && Number(p.maxTokens) > 0) body.max_tokens = Math.floor(Number(p.maxTokens));
    if (p.presencePenalty != null) body.presence_penalty = Number(p.presencePenalty);
    if (p.frequencyPenalty != null) body.frequency_penalty = Number(p.frequencyPenalty);
    if (o.tools && o.tools.length) {
      body.tools = o.tools;
      body.tool_choice = 'auto';
    }
    if (o.providerId === 'openai' && o.thinking && o.thinking !== 'none') {
      body.reasoning_effort = o.thinking;
    }
    return body;
  }

  /** Anthropic 消息/工具翻译 */
  function anthropicContent(parts, role, toolUses, toolResults) {
    const blocks = [];
    const arr = Array.isArray(parts) ? parts : [{ type: 'text', text: String(parts == null ? '' : parts) }];
    arr.forEach(function (p) {
      if (p && p.type === 'image_url' && p.image_url && p.image_url.url) {
        const url = String(p.image_url.url);
        const m = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      } else if (p && p.type === 'text') {
        blocks.push({ type: 'text', text: String(p.text == null ? '' : p.text) });
      }
    });
    (toolUses || []).forEach(function (tc) {
      blocks.push({
        type: 'tool_use',
        id: tc.id || uid('toolu'),
        name: tc.name,
        input: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : parseJson(tc.arguments, {}),
      });
    });
    (toolResults || []).forEach(function (tr) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: tr.tool_call_id || tr.id,
        content: String(tr.content == null ? '' : tr.content),
        is_error: !!tr.is_error,
      });
    });
    return blocks;
  }

  function anthropicMessages(messages) {
    const out = [];
    const systemParts = [];
    messages.forEach(function (m) {
      if (!m || !m.role) return;
      if (m.role === 'system') {
        systemParts.push(typeof m.content === 'string' ? m.content : '');
        return;
      }
      if (m.role === 'tool') {
        out.push({ role: 'user', content: anthropicContent('', null, null, [{ tool_call_id: m.tool_call_id, content: m.content, is_error: false }]) });
        return;
      }
      const content = anthropicContent(m.content, m.role, m.tool_calls, null);
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
    });
    return { system: systemParts.join('\n\n'), messages: out };
  }

  function anthropicTool(t) {
    return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } };
  }

  function buildAnthropicBody(o) {
    const converted = anthropicMessages(o.messages);
    const maxTokens = Math.max(1, Math.floor(Number(o.params && o.params.maxTokens) || 8192));
    const budget = thinkingBudget(o.thinking);
    const body = {
      model: o.model,
      max_tokens: Math.max(maxTokens, budget + 1024),
      stream: true,
      messages: converted.messages,
    };
    if (converted.system) body.system = converted.system;
    if (o.tools && o.tools.length) body.tools = o.tools.map(anthropicTool);
    if (budget > 0) body.thinking = { type: 'enabled', budget_tokens: budget };
    const p = o.params || {};
    if (p.temperature != null && p.temperature !== '') body.temperature = Math.max(0, Math.min(1, Number(p.temperature)));
    if (p.topP != null && p.topP !== '') body.top_p = Number(p.topP);
    return body;
  }

  /** 上游 fetch + SSE 迭代 */
  async function fetchStream(url, headers, body, signal) {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const text = await res.text().catch(function () { return ''; });
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = (j.error && j.error.message) || (j.message) || text;
      } catch (e) { /* ignore */ }
      const err = new Error(String(msg || ('HTTP ' + res.status)).slice(0, 500));
      err.status = res.status;
      throw err;
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('上游未返回流式响应');
    }
    return res.body.getReader();
  }

  /** 通用 SSE 行 → JSON 解析器 */
  function createSseLineParser(onData, onDone) {
    let buffer = '';
    return function push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const t = line.replace(/\r$/, '');
        if (t.indexOf('data:') === 0) {
          const data = t.slice(5).trim();
          if (data === '[DONE]') {
            if (onDone) onDone();
          } else {
            onData(data);
          }
        }
      }
    };
  }

  /** OpenAI 兼容流处理 → 统一事件 */
  function openaiStream(onEvent) {
    let acc = { text: '', thinking: '', toolCalls: [], finishReason: null, usage: null };
    const calls = {}; // index -> {id,name,arguments}
    const started = {};
    const push = createSseLineParser(function (data) {
      let obj;
      try { obj = JSON.parse(data); } catch (e) { return; }
      if (obj.usage) acc.usage = obj.usage;
      const choices = obj.choices || [];
      choices.forEach(function (c) {
        const delta = c.delta || {};
        if (delta.content) {
          acc.text += delta.content;
          onEvent({ type: 'delta', text: delta.content });
        }
        const reason = delta.reasoning_content || delta.reasoning || delta.thinking || (delta.reasoning_details && delta.reasoning_details.text);
        if (reason) {
          acc.thinking += reason;
          onEvent({ type: 'thinking', text: reason });
        }
        const toolCalls = delta.tool_calls || [];
        toolCalls.forEach(function (tc) {
          const idx = tc.index != null ? tc.index : 0;
          if (!calls[idx]) calls[idx] = { id: '', name: '', arguments: '' };
          if (tc.id) calls[idx].id = tc.id;
          if (tc.function) {
            if (tc.function.name) calls[idx].name = (calls[idx].name || '') + tc.function.name;
            if (tc.function.arguments) {
              calls[idx].arguments += tc.function.arguments;
              onEvent({ type: 'tool_arg', id: calls[idx].id || String(idx), text: tc.function.arguments });
            }
          }
          if (!started[idx] && (calls[idx].name || calls[idx].id)) {
            started[idx] = true;
            onEvent({ type: 'tool_start', id: calls[idx].id || String(idx), name: calls[idx].name });
          }
        });
        if (c.finish_reason) acc.finishReason = c.finish_reason;
      });
    });
    return {
      push,
      finish() {
        const list = Object.keys(calls).map(function (k) {
          const c = calls[k];
          let args = {};
          try { args = c.arguments ? JSON.parse(c.arguments) : {}; } catch (e) { args = { __raw: c.arguments }; }
          return { id: c.id, name: c.name, arguments: c.arguments, args };
        });
        acc.toolCalls = list;
        return acc;
      },
    };
  }

  /** Anthropic 流处理 → 统一事件 */
  function anthropicStream(onEvent) {
    let acc = { text: '', thinking: '', toolCalls: [], finishReason: null, usage: null };
    let currentBlock = null;
    const calls = {}; // index -> {id,name,arguments}
    const started = {};
    const push = createSseLineParser(function (data) {
      let ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      const type = ev.type;
      if (type === 'message_start') {
        if (ev.message && ev.message.usage) acc.usage = ev.message.usage;
        return;
      }
      if (type === 'content_block_start') {
        const block = ev.content_block || {};
        currentBlock = block;
        if (block.type === 'tool_use') {
          const idx = ev.index != null ? ev.index : 0;
          calls[idx] = { id: block.id || uid('toolu'), name: block.name || '', arguments: '' };
          if (!started[idx]) {
            started[idx] = true;
            onEvent({ type: 'tool_start', id: calls[idx].id, name: calls[idx].name });
          }
        }
        return;
      }
      if (type === 'content_block_delta') {
        const delta = ev.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          acc.text += delta.text;
          onEvent({ type: 'delta', text: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          acc.thinking += delta.thinking;
          onEvent({ type: 'thinking', text: delta.thinking });
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const idx = ev.index != null ? ev.index : 0;
          if (calls[idx]) {
            calls[idx].arguments += delta.partial_json;
            onEvent({ type: 'tool_arg', id: calls[idx].id, text: delta.partial_json });
          }
        }
        return;
      }
      if (type === 'message_delta') {
        const d = ev.delta || {};
        if (d.stop_reason) acc.finishReason = d.stop_reason;
        if (d.usage) acc.usage = d.usage;
      }
    });
    return {
      push,
      finish() {
        const list = Object.keys(calls).map(function (k) {
          const c = calls[k];
          let args = {};
          try { args = c.arguments ? JSON.parse(c.arguments) : {}; } catch (e) { args = { __raw: c.arguments }; }
          return { id: c.id, name: c.name, arguments: c.arguments, args };
        });
        acc.toolCalls = list;
        return acc;
      },
    };
  }

  /** 单次上游补全(流式)→ 返回累计结果 */
  async function streamOnce(provider, apiKey, o, onEvent, signal) {
    const base = (provider.baseUrl || '').replace(/\/+$/, '');
    const isAnthropic = provider.kind === 'anthropic';
    const url = isAnthropic ? base + '/messages' : base + '/chat/completions';
    const headers = {};
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiKey) {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'text/event-stream';
    const body = isAnthropic ? buildAnthropicBody(o) : buildOpenAIBody(o);

    const reader = await fetchStream(url, headers, body, signal);
    const handler = isAnthropic ? anthropicStream(onEvent) : openaiStream(onEvent);
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      handler.push(chunk);
    }
    return handler.finish();
  }

  /* ---------- 工具定义 ---------- */
  const WEB_SEARCH_TOOL = {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web and return top results (titles, URLs and snippets).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  };

  function mcpToolDefs(config, servers) {
    const defs = [];
    servers.forEach(function (s) {
      if (!s.enabled) return;
      (s.tools || []).forEach(function (t) {
        if (!t.name) return;
        if (t.enabled === false) return;
        defs.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || t.name,
            parameters: { type: 'object', properties: {}, additionalProperties: true },
          },
        });
      });
    });
    return defs;
  }

  /** 执行单个工具调用(名称 → MCP 工具 / 联网搜索) */
  async function executeTool(config, secrets, name, args, opts) {
    if (name === 'web_search') {
      const provider = opts.searchProvider || config.defaults.webSearchProvider || 'duckduckgo';
      const keys = secrets.searchKeys || {};
      const data = await webSearch({ fetchImpl }, provider, args.query, keys);
      return { ok: true, output: JSON.stringify(data.results), raw: data };
    }
    // 在启用的 MCP 服务器中查找工具
    for (const s of config.mcp) {
      if (!s.enabled) continue;
      const hit = (s.tools || []).find(function (t) { return t.name === name && t.enabled !== false; });
      if (hit) {
        const r = await mcp.callTool({ url: s.url, protocol: s.protocol, headers: s.headers }, name, args);
        return { ok: r.ok, output: r.ok ? r.result : (r.error || '工具调用失败'), raw: r.raw || r.result };
      }
    }
    return { ok: false, output: '未启用的工具: ' + name };
  }

  /* ---------- 流式对话(含工具调用循环) ---------- */
  async function streamChat(payload, ctx) {
    ctx = ctx || {};
    const onEvent = ctx.onEvent || function () {};
    const signal = ctx.signal || null;
    const isAborted = ctx.isAborted || function () { return false; };

    const { config, secrets } = await loadAll();
    const provider = resolveProvider(config, payload.providerId || config.defaults.provider);
    if (!provider) {
      onEvent({ type: 'error', message: '未知供应商,请在右侧参数面板选择或新增供应商' });
      return { text: '', thinking: '' };
    }
    const apiKey = (secrets.providerKeys && secrets.providerKeys[provider.id]) || payload.apiKey || '';
    if (provider.kind !== 'anthropic' && provider.id !== 'ollama' && provider.id !== 'lmstudio' && !apiKey) {
      // 仅本地供应商允许无 Key;其余给出明确提示
      onEvent({ type: 'error', message: '供应商 ' + provider.name + ' 未配置 API Key,请在参数面板填写' });
      return { text: '', thinking: '' };
    }

    const params = Object.assign({}, config.defaults.params, isPlainObject(payload.params) ? payload.params : {});
    const thinking = payload.thinking || config.defaults.thinking || 'none';
    const webSearchOn = payload.webSearch !== undefined ? !!payload.webSearch : !!config.defaults.webSearch;
    const mcpOn = payload.mcpEnabled !== undefined ? !!payload.mcpEnabled : config.defaults.mcpEnabled !== false;

    const toolDefs = [];
    if (mcpOn) toolDefs.push.apply(toolDefs, mcpToolDefs(config, config.mcp));
    if (webSearchOn) toolDefs.push(WEB_SEARCH_TOOL);

    const promptId = payload.promptId || config.defaults.promptId;
    const messages = [];
    if (promptId) {
      const prompt = (config.prompts || []).find(function (p) { return p.id === promptId; });
      if (prompt && prompt.content) messages.push({ role: 'system', content: prompt.content });
    }
    (payload.messages || []).forEach(function (m) { messages.push(m); });

    onEvent({ type: 'start' });
    let accText = '';
    let accThinking = '';

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      if (isAborted()) break;
      const res = await streamOnce(provider, apiKey, {
        providerId: provider.id,
        model: payload.model || config.defaults.model,
        messages,
        params,
        thinking,
        tools: toolDefs.length ? toolDefs : undefined,
      }, onEvent, signal);

      accText += res.text;
      accThinking += res.thinking;
      const hasTools = res.toolCalls && res.toolCalls.length;
      const isToolFinish =
        res.finishReason === 'tool_calls' || res.finishReason === 'tool_use' || (hasTools && res.finishReason !== 'stop');

      if (!hasTools || !isToolFinish) {
        onEvent({ type: 'done', finishReason: res.finishReason, usage: res.usage });
        return { text: accText, thinking: accThinking, finishReason: res.finishReason };
      }

      // 工具调用循环:先回填 assistant tool_calls 消息,再执行并回填结果
      const assistantMsg = {
        role: 'assistant',
        content: res.text || null,
        tool_calls: res.toolCalls.map(function (tc) {
          return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments || '{}' } };
        }),
      };
      messages.push(assistantMsg);

      for (const tc of res.toolCalls) {
        if (isAborted()) break;
        let args = tc.args;
        if (tc.arguments && typeof tc.arguments === 'string') {
          try { args = JSON.parse(tc.arguments); } catch (e) { args = { __raw: tc.arguments }; }
        }
        onEvent({ type: 'tool_end', id: tc.id, name: tc.name, args });
        const r = await executeTool(config, secrets, tc.name, args || {}, {
          searchProvider: payload.webSearchProvider,
        });
        onEvent({
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          ok: r.ok,
          output: r.output,
          error: r.error,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: r.ok ? r.output : 'ERROR: ' + (r.error || r.output),
        });
      }
    }
    onEvent({ type: 'done', finishReason: 'max_loops' });
    return { text: accText, thinking: accThinking, finishReason: 'max_loops' };
  }

  /* ============================================================
   * 会话 CRUD
   * ============================================================ */

  function rowToConversation(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title || '',
      groupId: row.group_id || '',
      tagIds: parseJson(row.tag_ids, []),
      favorite: !!row.favorite,
      pinned: !!row.pinned,
      archived: !!row.archived,
      provider: row.provider || '',
      model: row.model || '',
      promptId: row.prompt_id || '',
      params: parseJson(row.params, {}),
      messages: parseJson(row.messages, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function previewOf(conv) {
    const msgs = conv.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content
          .map(function (p) { return p && p.text ? p.text : (p && p.type === 'image_url' ? '[图片]' : ''); })
          .join(' ');
      } else if (m.toolCalls && m.toolCalls.length) {
        text = '[工具调用] ' + m.toolCalls.map(function (t) { return t.name; }).join(', ');
      }
      if (text) return { text: String(text).slice(0, 120), role: m.role, updatedAt: m.createdAt || conv.updatedAt };
    }
    return { text: '', role: '', updatedAt: conv.updatedAt };
  }

  async function listConversations() {
    const ws = await resolveWorkspace();
    const rows = await db.query(
      'SELECT * FROM chat_conversations WHERE workspace_id = ? ORDER BY pinned DESC, updated_at DESC',
      [ws]
    );
    return (rows || []).map(function (row) {
      const conv = rowToConversation(row);
      const preview = previewOf(conv);
      delete conv.messages;
      conv.preview = preview.text;
      conv.previewRole = preview.role;
      conv.messageCount = countMessages(row.messages);
      return conv;
    });
  }

  function countMessages(messagesJson) {
    const list = parseJson(messagesJson, []);
    return Array.isArray(list) ? list.length : 0;
  }

  async function getConversation(id) {
    const ws = await resolveWorkspace();
    const row = await db.get('SELECT * FROM chat_conversations WHERE id = ? AND workspace_id = ?', [id, ws]);
    return rowToConversation(row);
  }

  function normalizeConversation(input, existing) {
    const base = existing || {};
    const out = {
      id: validId(input && input.id) ? String(input.id) : (base.id || uid('conv')),
      title: typeof input.title === 'string' ? input.title.slice(0, 200) : base.title || '',
      groupId: typeof input.groupId === 'string' ? input.groupId : base.groupId || '',
      tagIds: Array.isArray(input.tagIds) ? input.tagIds.filter(validId).map(String) : base.tagIds || [],
      favorite: input.favorite !== undefined ? !!input.favorite : !!base.favorite,
      pinned: input.pinned !== undefined ? !!input.pinned : !!base.pinned,
      archived: input.archived !== undefined ? !!input.archived : !!base.archived,
      provider: typeof input.provider === 'string' ? input.provider : base.provider || '',
      model: typeof input.model === 'string' ? input.model : base.model || '',
      promptId: typeof input.promptId === 'string' ? input.promptId : base.promptId || '',
      params: isPlainObject(input.params) ? input.params : (base.params || {}),
      messages: Array.isArray(input.messages) ? input.messages : base.messages || [],
    };
    return out;
  }

  async function upsertConversation(input) {
    if (!isPlainObject(input)) throw new Error('需要 conversation 对象');
    const existing = validId(input.id) ? await getConversation(input.id) : null;
    const c = normalizeConversation(input, existing);
    const ws = await resolveWorkspace();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO chat_conversations
        (id, workspace_id, title, group_id, tag_ids, favorite, pinned, archived, provider, model, prompt_id, params, messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, group_id = excluded.group_id, tag_ids = excluded.tag_ids,
        favorite = excluded.favorite, pinned = excluded.pinned, archived = excluded.archived,
        provider = excluded.provider, model = excluded.model, prompt_id = excluded.prompt_id,
        params = excluded.params, messages = excluded.messages, updated_at = excluded.updated_at`,
      [
        c.id, ws, c.title, c.groupId, JSON.stringify(c.tagIds),
        c.favorite ? 1 : 0, c.pinned ? 1 : 0, c.archived ? 1 : 0,
        c.provider, c.model, c.promptId, JSON.stringify(c.params),
        JSON.stringify(c.messages), existing ? existing.createdAt : now, now,
      ]
    );
    return getConversation(c.id);
  }

  async function deleteConversations(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('需要 ids 数组');
    const ws = await resolveWorkspace();
    let removed = 0;
    for (const id of ids) {
      if (!validId(id)) continue;
      const r = await db.run('DELETE FROM chat_conversations WHERE id = ? AND workspace_id = ?', [id, ws]);
      removed += r.changes || 0;
    }
    return { removed };
  }

  return {
    defaultConfig,
    BUILTIN_PROMPTS,
    loadAll,
    saveAll,
    resolveProvider,
    listModels,
    listConversations,
    getConversation,
    upsertConversation,
    deleteConversations,
    streamChat,
  };
}

module.exports = { createChat, defaultConfig, BUILTIN_PROMPTS };
