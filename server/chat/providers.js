/* ============================================================
 * chat/providers.js — 大模型供应商目录(纯逻辑,Node / Worker 共用)
 * ------------------------------------------------------------
 * 每个供应商一行元数据:
 *   id       前端选择器/配置的稳定标识
 *   name     显示名
 *   kind     'openai'  → OpenAI 兼容 chat/completions 接口(绝大多数)
 *            'anthropic' → Anthropic Messages 原生接口(需格式翻译)
 *   baseUrl  无需用户手填的默认地址
 *   models   内置默认模型列表(仅作下拉便捷项;真实列表以「获取模型」为准)
 *   multimodal  是否原生支持图片/多模态输入(便于前端提示)
 *   headers  可选额外请求头(默认 Authorization: Bearer <key>)
 *
 * 用户选择供应商后无需再输入 baseUrl;自定义供应商走 openai 兼容
 * chat/completions 格式(由用户在配置中新增,字段含 baseUrl)。
 * ============================================================ */
'use strict';

/**
 * 内置供应商目录。模型列表为「常见默认值」,不保证穷尽;
 * 前端提供「自动获取模型列表」按钮,调用各供应商 /models 接口拿最新列表。
 */
const PROVIDERS = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: ['mimo-v2.5'],
    multimodal: true,
    note: '兼容 OpenAI chat/completions 接口的测试供应商(支持多模态)',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'o3-mini', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    multimodal: true,
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-4', 'claude-haiku-4'],
    multimodal: true,
  },
  {
    id: 'gemini',
    name: 'Gemini (Google)',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    multimodal: true,
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-4-fast', 'grok-4-mini', 'grok-3', 'grok-3-mini'],
    multimodal: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-4-maverick-17b-128e-instruct', 'llama-4-scout-17b-16e-instruct', 'qwen-3-32b', 'deepseek-r1-distill-llama-70b'],
    multimodal: false,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    kind: 'openai',
    baseUrl: 'https://api-inference.huggingface.co/v1',
    models: ['meta-llama/Llama-4-Maverick-17B-128E-Instruct', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen/Qwen3-32B', 'mistralai/Mistral-Small-3.1-24B-Instruct-2503'],
    multimodal: false,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'llama-4-maverick-17b-128e', 'gpt-oss-120b'],
    multimodal: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-5', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-v4-flash', 'qwen/qwen3-max', 'moonshotai/kimi-k2.5'],
    multimodal: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4', 'deepseek-reasoner'],
    multimodal: false,
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.5', 'kimi-k2-turbo-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    multimodal: true,
  },
  {
    id: 'glm',
    name: 'GLM (智谱)',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-z1-air'],
    multimodal: true,
  },
  {
    id: 'qwen',
    name: 'Qwen (通义千问)',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen3-235b-a22b', 'qwen3-32b', 'qwen-plus', 'qwen-turbo', 'qwen-vl-max', 'qwen-vl-plus'],
    multimodal: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3.1', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B', 'Qwen/Qwen3-32B', 'THUDM/GLM-4.5-Air', 'moonshotai/Kimi-K2-Instruct'],
    multimodal: true,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
    multimodal: false,
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    kind: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning'],
    multimodal: false,
  },
  {
    id: 'cohere',
    name: 'Cohere',
    kind: 'openai',
    baseUrl: 'https://api.cohere.com/v1',
    models: ['command-r-plus', 'command-r', 'command-a-v2'],
    multimodal: false,
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-4-Maverick-17B-128E-Instruct', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'deepseek-ai/DeepSeek-V3.1'],
    multimodal: false,
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama4-maverick-instruct-basic', 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507'],
    multimodal: false,
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.3', 'qwen3', 'deepseek-r1'],
    multimodal: false,
    local: true,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (本地)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    multimodal: false,
    local: true,
  },
];

const PROVIDER_INDEX = (function () {
  const map = {};
  PROVIDERS.forEach(function (p) {
    map[p.id] = p;
  });
  return map;
})();

function providerById(id) {
  return PROVIDER_INDEX[id] || null;
}

/** 供应商列表(含自定义:custom 标记由配置合并,此处只提供内置目录) */
function builtinProviders() {
  return PROVIDERS.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      models: (p.models || []).slice(),
      multimodal: !!p.multimodal,
      local: !!p.local,
      note: p.note || '',
    };
  });
}

module.exports = { PROVIDERS, providerById, builtinProviders };
