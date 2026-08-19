/* ============================================================
 * chats 模块 — 实现(懒加载,首次访问 #/chats 时下载)
 * ------------------------------------------------------------
 * 三栏 AI 聊天工作台:
 *   左栏  会话历史(分组/标签 3:7 + 模糊搜索 + 会话列表 CRUD)
 *   中栏  聊天界面(流式 markdown / 思维链 / 工具调用 / Claude 风输入框)
 *   右栏  模型参数 / MCP / Agent(占位),默认折叠
 * 移动端:左右侧边栏折叠为汉堡抽屉。
 *
 * 后端配合 server/chat/index.js + server/api/routes/chat.js:
 *   供应商 / 模型 / 流式补全 / MCP 工具调用 / 会话持久化均在服务端,
 *   API Key 服务端加密落库,浏览器仅收发统一 SSE 事件。
 * 只依赖核心层 App.api / App.ui / App.icon / App.i18n / ctx。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 工具 ---------- */
  function icon(name, cls) {
    return App.icon.iconSvg(name, { class: cls || 'size-4' });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escAttr(s) {
    return esc(s);
  }
  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function nowIso() {
    return new Date().toISOString();
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) {
      return n < 10 ? '0' + n : '' + n;
    }
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    );
  }
  function fmtAgo(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var days = Math.floor(h / 24);
    if (days < 7) return days + ' 天前';
    return fmtTime(iso).slice(0, 10);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          App.ui.toast('已复制');
        },
        function () {
          fallbackCopy(text);
        }
      );
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      App.ui.toast('已复制');
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  /* ---------- i18n(模块词典优先;缺键回退英文) ---------- */
  function moduleT() {
    var locale = App.getShellContext ? App.getShellContext().settings.locale : 'zh-CN';
    return App.i18n.makeT(locale, window.__moduleI18n && window.__moduleI18n.chats);
  }
  function L(key, fallback) {
    var v = moduleT()(key);
    return v === key ? (fallback != null ? fallback : key) : v;
  }

  function currentWorkspaceId() {
    var ctx = App.getShellContext ? App.getShellContext() : null;
    return (ctx && ctx.settings && ctx.settings.activeWorkspace) || 'ws-default';
  }

  /* 移动端判定(与 CSS 断点 960px 保持一致):
   * 移动端左右侧边栏均为汉堡抽屉;桌面端左栏默认展开、右栏折叠。
   * 蒙版(scrim)仅在移动端抽屉展开时出现,且点击蒙版关闭抽屉。 */
  function isMobileLayout() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 960px)').matches);
  }

  (function initLayoutWatcher() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(max-width: 960px)');
    function changed(e) {
      if (e.matches) {
        // 进入移动端:左右侧边栏同时折叠为汉堡抽屉
        state.leftOpen = false;
        state.rightOpen = false;
        state.scrim = false;
      } else {
        // 回到桌面端:左栏恢复展开,右栏保持折叠
        state.leftOpen = true; // kept
        state.scrim = false;
      }
      rerender();
    }
    if (mq.addEventListener) mq.addEventListener('change', changed);
    else if (mq.addListener) mq.addListener(changed);
  })();

  /* ============================================================
   * 状态
   * ============================================================ */
  var state = {
    loaded: false,
    error: null,
    config: null,
    secrets: null,
    conversations: [], // 列表元数据
    selectedId: null,
    conv: null, // 当前会话(含 messages)
    active: null, // 当前生效参数(provider/model/params/promptId/thinking/…)
    sideTab: 'groups',
    sideSearch: '',
    listSearch: '',
    groupFilter: null,
    tagFilter: null,
    filter: 'all', // all / fav / pin / archive
    rightTab: 'params',
    rightOpen: false,
    leftOpen: true,
    scrim: false,
    input: '',
    attachments: [],
    editing: null, // { id }
    streaming: false,
    streamConvId: null,
    abortCtrl: null,
    models: {}, // providerId -> { loading, list }
    dialog: null,
    ctx: null, // { id, x, y }
    dragSlider: null,
    mcpOpen: {}, // MCP 卡片: 工具列表展开状态
    mcpBusy: null, // MCP 卡片: 正在拉取工具的服务器 id
  };

  function defaults() {
    var c = state.config || {};
    var d = (c.defaults && c.defaults.defaults) || c.defaults || {};
    return {
      provider: d.provider || 'opencode-go',
      model: d.model || '',
      params: Object.assign(
        { temperature: 0.7, topP: 1, topK: 0, maxTokens: 8192, presencePenalty: 0, frequencyPenalty: 0 },
        d.params || {}
      ),
      promptId: d.promptId || '',
      thinking: d.thinking || 'none',
      webSearch: !!d.webSearch,
      webSearchProvider: d.webSearchProvider || 'duckduckgo',
      mcpEnabled: d.mcpEnabled !== false,
    };
  }

  /* ============================================================
   * 消息组装 / 发送(权威实现,覆盖下方同名函数声明)
   * ------------------------------------------------------------
   * 修复两点:
   *   1. 编辑:替换原用户消息并截断其后内容,再自动触发新响应;
   *   2. 多轮:跳过流式空占位,并回传 assistant 的 tool_calls 与
   *      tool 返回结果,保证后续轮次的工具调用上下文完整。
   * ============================================================ */
  apiMessages = function (conv) {
    var out = [];
    (conv.messages || []).forEach(function (m) {
      if (m.role === 'user') {
        var text = m.content || '';
        var atts = m.attachments || [];
        var fileTexts = [];
        atts.forEach(function (a) {
          if (a.kind === 'file' && a.text) fileTexts.push('【文件 ' + (a.name || '') + '】\n' + a.text);
          else if (a.kind === 'file' && a.url) fileTexts.push('【文件链接】' + a.url);
        });
        if (fileTexts.length) text = (text ? text + '\n\n' : '') + fileTexts.join('\n\n');
        var images = atts.filter(function (a) { return a.kind === 'image' && (a.dataUrl || a.url); });
        if (images.length) {
          var parts = [{ type: 'text', text: text }];
          images.forEach(function (a) { parts.push({ type: 'image_url', image_url: { url: a.dataUrl || a.url } }); });
          out.push({ role: 'user', content: parts });
        } else {
          out.push({ role: 'user', content: text });
        }
      } else if (m.role === 'assistant') {
        if (m.streaming) return; // 跳过进行中的空占位
        var toolCalls = (m.toolCalls || []).filter(function (t) { return t.name; });
        var amsg = { role: 'assistant', content: m.content || '' };
        if (toolCalls.length) {
          amsg.tool_calls = toolCalls.map(function (t) {
            return {
              id: t.id || uid('call'),
              type: 'function',
              function: { name: t.name, arguments: typeof t.args === 'string' ? t.args : JSON.stringify(t.args || {}) },
            };
          });
          amsg.content = m.content || null;
        }
        out.push(amsg);
        toolCalls.forEach(function (t) {
          if (t.output != null && t.output !== '') {
            out.push({
              role: 'tool',
              tool_call_id: t.id || uid('call'),
              content: typeof t.output === 'string' ? t.output : JSON.stringify(t.output),
            });
          }
        });
      }
    });
    return out;
  };

  sendMessage = function () {
    if (!canSend()) return;
    var text = state.input;
    var atts = state.attachments.slice();
    var editing = state.editing;
    state.input = '';
    state.attachments = [];
    state.editing = null;

    var conv = state.conv;
    if (!conv) {
      conv = {
        id: uid('conv'),
        title: text.slice(0, 40) || '新对话',
        groupId: state.groupFilter || '',
        tagIds: state.tagFilter ? [state.tagFilter] : [],
        favorite: false, pinned: false, archived: false,
        provider: state.active.provider, model: state.active.model,
        promptId: state.active.promptId, params: Object.assign({}, state.active.params),
        messages: [], createdAt: nowIso(), updatedAt: nowIso(),
      };
      state.conv = conv;
      state.selectedId = conv.id;
      state.conversations.unshift({
        id: conv.id, title: conv.title, groupId: conv.groupId, tagIds: conv.tagIds,
        favorite: false, pinned: false, archived: false, preview: text.slice(0, 80),
        messageCount: 0, provider: conv.provider, model: conv.model, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
      });
    }
    if (editing && editing.id) {
      // 编辑:替换原用户消息并截断其后所有内容,再触发新响应
      var idx = -1;
      for (var i = 0; i < conv.messages.length; i++) {
        if (conv.messages[i].id === editing.id) { idx = i; break; }
      }
      if (idx !== -1) {
        conv.messages[idx].content = text;
        conv.messages[idx].attachments = atts;
        conv.messages[idx].updatedAt = nowIso();
        conv.messages = conv.messages.slice(0, idx + 1);
      } else {
        conv.messages.push({ id: uid('m'), role: 'user', content: text, attachments: atts, createdAt: nowIso() });
      }
    } else {
      conv.messages.push({ id: uid('m'), role: 'user', content: text, attachments: atts, createdAt: nowIso() });
    }
    conv.updatedAt = nowIso();
    conv.title = conv.title || text.slice(0, 40);
    startAssistantStream(conv);
  };

  /* ============================================================
   * 供应商 / 模型
   * ============================================================ */
  function builtinProviders() {
    // 与 server/chat/providers.js 保持一致的目录(前端冗余一份用于即时渲染)
    return [
      { id: 'opencode-go', name: 'OpenCode Go', kind: 'openai', multimodal: true },
      { id: 'openai', name: 'OpenAI', kind: 'openai', multimodal: true },
      { id: 'anthropic', name: 'Claude (Anthropic)', kind: 'anthropic', multimodal: true },
      { id: 'gemini', name: 'Gemini (Google)', kind: 'openai', multimodal: true },
      { id: 'grok', name: 'Grok (xAI)', kind: 'openai', multimodal: true },
      { id: 'groq', name: 'Groq', kind: 'openai', multimodal: false },
      { id: 'huggingface', name: 'Hugging Face', kind: 'openai', multimodal: false },
      { id: 'cerebras', name: 'Cerebras', kind: 'openai', multimodal: false },
      { id: 'openrouter', name: 'OpenRouter', kind: 'openai', multimodal: true },
      { id: 'deepseek', name: 'DeepSeek', kind: 'openai', multimodal: false },
      { id: 'kimi', name: 'Kimi (Moonshot)', kind: 'openai', multimodal: true },
      { id: 'glm', name: 'GLM (智谱)', kind: 'openai', multimodal: true },
      { id: 'qwen', name: 'Qwen (通义千问)', kind: 'openai', multimodal: true },
      { id: 'siliconflow', name: '硅基流动 (SiliconFlow)', kind: 'openai', multimodal: true },
      { id: 'mistral', name: 'Mistral', kind: 'openai', multimodal: false },
      { id: 'perplexity', name: 'Perplexity', kind: 'openai', multimodal: false },
      { id: 'cohere', name: 'Cohere', kind: 'openai', multimodal: false },
      { id: 'together', name: 'Together AI', kind: 'openai', multimodal: false },
      { id: 'fireworks', name: 'Fireworks AI', kind: 'openai', multimodal: false },
      { id: 'ollama', name: 'Ollama (本地)', kind: 'openai', multimodal: false, local: true },
      { id: 'lmstudio', name: 'LM Studio (本地)', kind: 'openai', multimodal: false, local: true },
    ];
  }
  function customProviders() {
    return (state.config && state.config.providers) || [];
  }
  function allProviders() {
    return builtinProviders().concat(
      customProviders().map(function (p) {
        return { id: p.id, name: p.name, kind: p.kind, multimodal: p.multimodal, custom: true };
      })
    );
  }
  function providerById(id) {
    var list = allProviders();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function providerModels(providerId) {
    var models = (state.models[providerId] && state.models[providerId].list) || [];
    if (!models.length && state.config && state.config.providers) {
      var c = customProviders().filter(function (p) { return p.id === providerId; })[0];
      if (c && c.models) models = c.models;
    }
    return models;
  }
  function providerKey(id) {
    return (state.secrets && state.secrets.providerKeys && state.secrets.providerKeys[id]) || '';
  }

  /* ============================================================
   * Markdown 渲染(零依赖,先转义后渲染,防 XSS)
   * ============================================================ */
  function safeUrl(u) {
    u = String(u || '');
    return /^(https?:|mailto:|data:image\/)/i.test(u) ? u : '';
  }
  function inlineMd(s) {
    s = String(s == null ? '' : s);
    // 图片 ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, alt, url) {
      url = safeUrl(url);
      return url ? '<img src="' + escAttr(url) + '" alt="' + escAttr(alt) + '" loading="lazy">' : esc(alt);
    });
    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, txt, url) {
      url = safeUrl(url);
      return url ? '<a href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>' : txt;
    });
    // 粗体 / 斜体 / 删除线
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 自动链接 <http…>(转义后为 &lt;http…&gt;)
    s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  /* ---------- 代码语法高亮(零依赖轻量分词器) ---------- */
  function normLang(lang) {
    var l = String(lang || '').toLowerCase().replace(/[\s_-]/g, '');
    var m = {
      js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js', jsx: 'js',
      ts: 'ts', typescript: 'ts', tsx: 'ts',
      py: 'py', python: 'py',
      json: 'json',
      bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
      sql: 'sql', mysql: 'sql', pgsql: 'sql', postgresql: 'sql',
      css: 'css', scss: 'css', less: 'css',
      html: 'html', xml: 'html', svg: 'html', xhtml: 'html',
      go: 'go', golang: 'go',
      rust: 'rust', rs: 'rust',
      java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
      cs: 'cs', csharp: 'cs', php: 'php', rb: 'rb', ruby: 'rb',
      yaml: 'yaml', yml: 'yaml', docker: 'docker', dockerfile: 'docker',
      md: 'md', markdown: 'md', plaintext: 'txt', text: 'txt', txt: 'txt',
    };
    return m[l] || 'txt';
  }

  var HL_KW = {
    js: 'const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super import export from default try catch finally throw async await yield this void with debugger',
    ts: 'const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super import export from default try catch finally throw async await yield this void type interface enum namespace declare readonly keyof infer never any unknown string number boolean symbol undefined satisfies as is',
    py: 'def return if elif else for while in not and or is import from as class try except finally raise with lambda yield global nonlocal pass break continue del assert async await',
    json: '',
    bash: 'if then else elif fi for while do done case esac in function return local export readonly echo exit set unset source shift trap',
    sql: 'select from where insert into values update set delete create table drop alter index join left right inner outer full on group by order having limit offset as and or not null is in like between exists union all distinct case when then end count sum avg min max',
    css: '',
    html: '',
    go: 'func return if else for range var const type struct interface map chan go select defer import package break continue fallthrough switch case default nil true false',
    rust: 'fn let mut return if else match for while loop in impl trait struct enum use mod pub crate self super where async await move ref const static type dyn as break continue true false',
    java: 'public private protected class interface extends implements return if else for while do switch case break continue new throw try catch finally import package static final void int long double float boolean char byte short abstract synchronized volatile transient this super null true false',
    c: 'return if else for while do switch case break continue struct typedef union enum sizeof static const volatile extern void int long double float char unsigned signed short auto register goto null true false',
    cpp: 'return if else for while do switch case break continue struct class typedef union enum sizeof static const volatile extern void int long double float char unsigned signed short auto register goto new delete this template typename namespace using public private protected virtual override nullptr true false',
    cs: 'public private protected class interface struct enum return if else for foreach while do switch case break continue new throw try catch finally using namespace static void int long double float bool char string decimal var async await get set this base null true false',
    php: 'function return if else elseif for foreach while do switch case break continue new class extends implements public private protected static final abstract interface trait namespace use echo print require include try catch finally throw as this null true false',
    rb: 'def return if elsif else unless for while do end class module require include extend new self nil true false begin rescue ensure case when then yield',
    yaml: 'true false null yes no on off',
    docker: 'from run cmd entrypoint copy add workdir env arg expose volume user label maintainer onbuild stopsignal healthcheck shell',
    md: '',
    txt: '',
  };

  var HL_BOOL = {
    js: 'true false null undefined NaN Infinity',
    ts: 'true false null undefined NaN Infinity',
    py: 'True False None',
    json: 'true false null',
    go: 'true false nil',
    rust: 'true false',
    java: 'true false null',
    c: 'true false null',
    cpp: 'true false nullptr',
    cs: 'true false null',
    php: 'true false null',
    rb: 'true false nil',
    yaml: 'true false null yes no on off',
  };

  function hl(src, lang) {
    var text = String(src == null ? '' : src);
    if (!text) return '';
    var l = normLang(lang);
    if (l === 'txt' || l === 'md') return esc(text);

    var commentRe;
    if (l === 'html') commentRe = /^<!--[\s\S]*?-->/;
    else if (l === 'css') commentRe = /^\/\*[\s\S]*?\*\//;
    else if (l === 'py' || l === 'bash' || l === 'rb' || l === 'yaml' || l === 'docker') commentRe = /^#[^\n]*/;
    else if (l === 'sql') commentRe = /^(?:--[^\n]*|\/\*[\s\S]*?\*\/)/;
    else commentRe = /^(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/;

    var strRe = /^(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/;
    var numRe = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d[\d_]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/;
    var kwList = HL_KW[l];
    var kwRe = kwList ? new RegExp('^(?:' + kwList.split(' ').join('|') + ')\\b') : null;
    var boolRe = null;
    var boolSet = HL_BOOL[l];
    if (boolSet) boolRe = new RegExp('^(?:' + boolSet.split(' ').join('|') + ')\\b');
    var fnRe = /^([A-Za-z_$][\w$]*)(?=\s*\()/;
    var isHtml = l === 'html';
    var isCss = l === 'css';

    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var chunk = text.slice(i);
      var m;
      if (isHtml) {
        var hcls = 'tok-tag';
        m = commentRe.exec(chunk);
        if (m) {
          hcls = 'tok-com';
        } else {
          m = /^(<\/?[a-zA-Z][\w-]*|\/?>)/.exec(chunk);
          if (!m) {
            m = /^[a-zA-Z-]+(?==)/.exec(chunk);
            if (m) hcls = 'tok-attr';
          }
          if (!m) {
            m = strRe.exec(chunk);
            if (m) hcls = 'tok-str';
          }
        }
        if (m) {
          out += '<span class="' + hcls + '">' + esc(m[0]) + '</span>';
          i += m[0].length;
          continue;
        }
      } else if (isCss) {
        var ccls = 'tok-num';
        m = commentRe.exec(chunk);
        if (m) {
          ccls = 'tok-com';
        } else {
          m = /^@[a-zA-Z-]+/.exec(chunk);
          if (m) ccls = 'tok-kw';
          if (!m) {
            m = /^[a-zA-Z-]+(?=\s*:)/.exec(chunk);
            if (m) ccls = 'tok-attr';
          }
          if (!m) {
            m = numRe.exec(chunk);
            if (m) ccls = 'tok-num';
          }
          if (!m) {
            m = strRe.exec(chunk);
            if (m) ccls = 'tok-str';
          }
        }
        if (m) {
          out += '<span class="' + ccls + '">' + esc(m[0]) + '</span>';
          i += m[0].length;
          continue;
        }
      } else {
        m = commentRe.exec(chunk);
        if (m) { out += '<span class="tok-com">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }
        m = strRe.exec(chunk);
        if (m) { out += '<span class="tok-str">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }
        m = numRe.exec(chunk);
        if (m) { out += '<span class="tok-num">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }
        if (boolRe && (m = boolRe.exec(chunk))) { out += '<span class="tok-bool">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }
        if (kwRe && (m = kwRe.exec(chunk))) { out += '<span class="tok-kw">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }
        m = fnRe.exec(chunk);
        if (m) { out += '<span class="tok-fn">' + esc(m[1]) + '</span>'; i += m[1].length; continue; }
      }
      out += esc(chunk.charAt(0));
      i += 1;
    }
    return out;
  }

  function md(src) {
    var text = String(src == null ? '' : src);
    // 1. 抽取代码块
    var fences = [];
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      fences.push({ lang: lang.trim(), code: code.replace(/\n$/, '') });
      return '\u0000F' + (fences.length - 1) + '\u0000';
    });
    // 2. 抽取行内代码
    var icodes = [];
    text = text.replace(/`([^`\n]+)`/g, function (_, c) {
      icodes.push(c);
      return '\u0001I' + (icodes.length - 1) + '\u0001';
    });
    // 3. 转义
    text = esc(text);

    // 4. 块级解析
    var lines = text.split('\n');
    var out = [];
    var para = [];
    var listType = null;

    function flushPara() {
      if (para.length) {
        out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
        para = [];
      }
    }
    function closeList() {
      if (listType) {
        out.push('</' + listType + '>');
        listType = null;
      }
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); closeList();
        var lvl = h[1].length;
        out.push('<h' + lvl + '>' + inlineMd(h[2]) + '</h' + lvl + '>');
        i++; continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushPara(); closeList(); out.push('<hr>'); i++; continue;
      }
      var bq = /^\s*&gt;\s?(.*)$/.exec(line);
      if (bq) {
        flushPara(); closeList();
        var q = [bq[1]];
        i++;
        while (i < lines.length) {
          var bq2 = /^\s*&gt;\s?(.*)$/.exec(lines[i]);
          if (!bq2) break;
          q.push(bq2[1]); i++;
        }
        out.push('<blockquote>' + q.map(inlineMd).join('<br>') + '</blockquote>');
        continue;
      }
      var ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      var ol = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var type = ul ? 'ul' : 'ol';
        if (listType !== type) {
          closeList();
          listType = type;
          out.push('<' + type + '>');
        }
        out.push('<li>' + inlineMd((ul || ol)[2]) + '</li>');
        i++; continue;
      }
      // 表格
      if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
        flushPara(); closeList();
        function cellsOf(l) {
          return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
        }
        var head = cellsOf(line);
        var rows = [];
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
          rows.push(cellsOf(lines[i])); i++;
        }
        out.push(
          '<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inlineMd(c) + '</td>'; }).join('') + '</tr>';
          }).join('') +
          '</tbody></table>'
        );
        continue;
      }
      if (line.trim() === '') {
        flushPara(); closeList(); i++; continue;
      }
      para.push(line); i++;
    }
    flushPara(); closeList();

    var html = out.join('');
    // 5. 还原行内代码 / 代码块
    html = html.replace(/\u0001I(\d+)\u0001/g, function (_, n) {
      return '<code>' + esc(icodes[+n]) + '</code>';
    });
    html = html.replace(/\u0000F(\d+)\u0000/g, function (_, n) {
      var f = fences[+n] || { code: '' };
      return (
        '<pre class="chat-codeblock">' +
        '<span class="chat-codeblock-lang">' + esc(f.lang || '') + '</span>' +
        '<button type="button" class="chat-code-copy" data-chat-code-copy>' + icon('copy', 'size-3') + '</button>' +
        '<code>' + hl(f.code, f.lang) + '</code></pre>'
      );
    });
    return html;
  }

  /* ============================================================
   * 数据加载 / 持久化
   * ============================================================ */
  var configTimer = null;
  var convTimer = null;

  function load() {
    state.error = null;
    App.api
      .get('/api/chat/state')
      .then(function (data) {
        state.config = data.config || null;
        state.secrets = data.secrets || { providerKeys: {}, searchKeys: {} };
        state.conversations = data.conversations || [];
        state.loaded = true;
        state.active = defaults();
        applyHashSelection();
        if (!state.selectedId && state.conversations.length) {
          var first = state.conversations[0];
          state.selectedId = first.id;
          loadConversation(first.id);
        } else if (state.selectedId) {
          loadConversation(state.selectedId);
        } else {
          state.conv = null;
          rerender();
        }
      })
      .catch(function (e) {
        state.error = (e && e.message) || '加载失败';
        rerender();
      });
  }

  function applyHashSelection() {
    var h = window.location.hash || '';
    var m = /[?&]c=([^&]+)/.exec(h);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    if (id && state.conversations.some(function (c) { return c.id === id; })) {
      state.selectedId = id;
    }
  }

  function loadConversation(id) {
    App.api
      .get('/api/chat/conversations?id=' + encodeURIComponent(id))
      .then(function (data) {
        state.conv = data.conversation || null;
        if (state.conv) {
          state.selectedId = state.conv.id;
          state.active = activeFromConv(state.conv);
        }
        persistSelection();
        rerender();
      })
      .catch(function (e) {
        state.conv = null;
        rerender();
      });
  }

  function activeFromConv(conv) {
    var d = defaults();
    return {
      provider: conv.provider || d.provider,
      model: conv.model || d.model,
      params: Object.assign({}, d.params, conv.params || {}),
      promptId: conv.promptId || d.promptId,
      thinking: d.thinking,
      webSearch: d.webSearch,
      webSearchProvider: d.webSearchProvider,
      mcpEnabled: d.mcpEnabled,
    };
  }

  function persistConfig() {
    if (!state.loaded) return;
    if (configTimer) clearTimeout(configTimer);
    configTimer = setTimeout(function () {
      configTimer = null;
      App.api
        .put('/api/chat/config', { config: state.config, secrets: state.secrets })
        .catch(function (e) {
          if (e && e.status !== 401) App.logger.warn('chats', '配置保存失败', e);
        });
    }, 400);
  }

  function saveConversation(conv) {
    if (!conv) return;
    if (convTimer) clearTimeout(convTimer);
    convTimer = setTimeout(function () {
      convTimer = null;
      App.api
        .put('/api/chat/conversations', { conversation: conv })
        .then(function () {
          refreshConversationMeta();
        })
        .catch(function (e) {
          if (e && e.status !== 401) App.logger.warn('chats', '会话保存失败', e);
        });
    }, 300);
  }

  function refreshConversationMeta() {
    if (!state.loaded) return;
    App.api
      .get('/api/chat/conversations')
      .then(function (data) {
        state.conversations = data.conversations || [];
        rerenderList();
      })
      .catch(function () {});
  }

  function persistSelection() {
    try {
      localStorage.setItem('html-template-chat-selected-' + currentWorkspaceId(), state.selectedId || '');
    } catch (e) {}
  }

  function restoreSelection() {
    try {
      return localStorage.getItem('html-template-chat-selected-' + currentWorkspaceId()) || '';
    } catch (e) {
      return '';
    }
  }

  /* ============================================================
   * 会话 CRUD 操作
   * ============================================================ */
  function findMsg(conv, id) {
    for (var i = 0; i < conv.messages.length; i++) if (conv.messages[i].id === id) return { index: i, msg: conv.messages[i] };
    return null;
  }

  function newConversation() {
    var c = {
      id: uid('conv'),
      title: '新对话',
      groupId: state.groupFilter || '',
      tagIds: state.tagFilter ? [state.tagFilter] : [],
      favorite: false,
      pinned: false,
      archived: false,
      provider: state.active.provider,
      model: state.active.model,
      promptId: state.active.promptId,
      params: Object.assign({}, state.active.params),
      messages: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.selectedId = c.id;
    state.conv = c;
    state.active = activeFromConv(c);
    state.conversations.unshift({
      id: c.id, title: c.title, groupId: c.groupId, tagIds: c.tagIds,
      favorite: false, pinned: false, archived: false, preview: '', messageCount: 0,
      provider: c.provider, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt,
    });
    persistSelection();
    saveConversation(c);
    rerender();
    focusComposer();
  }

  function selectConversation(id) {
    if (state.streaming && state.streamConvId === state.selectedId) return;
    state.selectedId = id;
    loadConversation(id);
  }

  function deleteConv(ids) {
    App.api
      .del('/api/chat/conversations', { ids: ids })
      .then(function () {
        App.ui.toast('已删除');
        state.conversations = state.conversations.filter(function (c) { return ids.indexOf(c.id) === -1; });
        if (ids.indexOf(state.selectedId) !== -1) {
          state.selectedId = null;
          state.conv = null;
          if (state.conversations.length) selectConversation(state.conversations[0].id);
        }
        persistSelection();
        rerender();
      })
      .catch(function (e) {
        App.ui.toast((e && e.message) || '删除失败', 'error');
      });
  }

  function patchConv(id, patch, opts) {
    if (state.conv && state.conv.id === id) {
      Object.keys(patch).forEach(function (k) { state.conv[k] = patch[k]; });
      saveConversation(state.conv);
      var meta = state.conversations.filter(function (c) { return c.id === id; })[0];
      if (meta) {
        Object.keys(patch).forEach(function (k) {
          if (k === 'tagIds' || k === 'groupId' || k === 'title' || k === 'favorite' || k === 'pinned' || k === 'archived')
            meta[k] = patch[k];
        });
      }
    }
    if (!opts || !opts.noRerender) rerender();
  }

  function toggleConvFlag(id, flag) {
    var conv = null;
    for (var i = 0; i < state.conversations.length; i++) if (state.conversations[i].id === id) conv = state.conversations[i];
    if (!conv) return;
    var next = !conv[flag];
    patchConv(id, (function () { var p = {}; p[flag] = next; return p; })());
    // 若当前选中会话在内存中,同步
    if (state.conv && state.conv.id === id) state.conv[flag] = next;
  }

  /* ============================================================
   * 参数变更
   * ============================================================ */
  function setActiveParam(key, value) {
    if (!state.active) return;
    state.active[key] = value;
    // 会话级字段写入会话,全局字段写入 defaults
    if (key === 'provider' || key === 'model' || key === 'promptId') {
      if (state.conv) {
        state.conv[key] = value;
        saveConversation(state.conv);
      } else {
        state.config.defaults[key] = value;
        persistConfig();
      }
    } else if (key === 'thinking' || key === 'webSearch' || key === 'webSearchProvider' || key === 'mcpEnabled') {
      state.config.defaults[key] = value;
      persistConfig();
    }
    // 无会话时 provider/model 变化后同步当前激活值即可
  }
  function setActiveParamDeep(key, value) {
    state.active.params[key] = value;
    if (state.conv) {
      state.conv.params = Object.assign({}, state.conv.params, state.active.params);
      saveConversation(state.conv);
    } else {
      state.config.defaults.params = Object.assign({}, state.config.defaults.params, state.active.params);
      persistConfig();
    }
  }

  function parseMaxTokens(s) {
    var v = String(s == null ? '' : s).trim().toLowerCase().replace(/,/g, '');
    if (!v) return null;
    var m = /^([0-9]*\.?[0-9]+)\s*(m|k)?$/.exec(v);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'k') n *= 1000;
    return Math.max(1, Math.floor(n));
  }
  function formatMaxTokens(n) {
    n = Number(n);
    if (!isFinite(n)) return '';
    if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + 'M';
    if (n >= 1000 && n % 1000 === 0) return (n / 1000) + 'k';
    return String(n);
  }

  /* ============================================================
   * 渲染:页面骨架
   * ============================================================ */
  function pageHtml() {
    return (
      '<div class="chat-root" data-chat-root>' +
      leftHtml() +
      mainHtml() +
      rightHtml() +
      dialogHtml() +
      ctxHtml() +
      '<div class="chat-scrim' + (state.scrim ? ' is-show' : '') + '" data-chat-scrim></div>' +
      '</div>'
    );
  }

  function render(route, ctx) {
    return pageHtml();
  }

  function rerender() {
    var region = document.querySelector('[data-chat-root]');
    if (!region) return;
    var msgsEl = region.querySelector('.chat-msgs');
    var scrollTop = msgsEl ? msgsEl.scrollTop : 0;
    region.outerHTML = pageHtml();
    var msgsEl2 = document.querySelector('[data-chat-root] .chat-msgs');
    if (msgsEl2 && !state.streaming) msgsEl2.scrollTop = scrollTop;
  }
  function rerenderLeft() {
    var el = document.querySelector('[data-chat-left]');
    if (el) el.outerHTML = leftHtml();
  }
  function rerenderList() {
    var el = document.querySelector('[data-chat-conv-list]');
    if (el) el.outerHTML = convListHtml();
    var tree = document.querySelector('[data-chat-side-tree]');
    if (tree) tree.outerHTML = sideTopHtml();
  }
  function rerenderMain() {
    var el = document.querySelector('[data-chat-main]');
    if (el) el.outerHTML = mainHtml();
  }
  function rerenderRight() {
    var el = document.querySelector('[data-chat-right]');
    if (el) el.outerHTML = rightHtml();
  }
  function focusComposer() {
    var ta = document.querySelector('[data-chat-textarea]');
    if (ta) ta.focus();
  }
  function scrollMsgsToBottom() {
    var el = document.querySelector('.chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  }

  /* ---------- 左栏 ---------- */
  function leftHtml() {
    return (
      '<aside class="chat-left' + (state.leftOpen ? ' is-open' : ' is-collapsed') + '" data-chat-left>' +
      '<div class="chat-left-head">' +
      '<button type="button" class="chat-composer-btn" data-chat-left-toggle data-tip="' + L('chats.collapseSidebar', 'Collapse sidebar') + '">' + icon('panel-left') + '</button>' +
      '<div class="chat-left-title"><span>' + L('chats.inbox', 'Conversations') + '</span></div>' +
      '<button type="button" class="chat-composer-btn" data-chat-new data-tip="' + L('chats.newChat', 'New chat') + '">' + icon('plus') + '</button>' +
      '</div>' +
      '<div class="chat-side-body">' +
      '<div class="chat-side-top">' +
      '<div class="chat-side-search">' +
      App.ui.searchInput.html({
        placeholder: L('chats.searchConversations', 'Search conversations…'),
        value: state.listSearch,
        attrs: 'data-chat-list-search',
        clearLabel: 'x',
      }) +
      '</div>' +
      filterRowHtml() +
      '<div class="chat-conv-list" data-chat-conv-list>' + convListHtml() + '</div>' +
      '</div>' +
      '<div class="chat-side-bottom">' +
      '<div class="chat-side-tabs">' +
      '<button type="button" class="chat-side-tab' + (state.sideTab === 'groups' ? ' is-active' : '') + '" data-chat-side-tab="groups">' + icon('folder') + L('chats.groups', 'Groups') + '</button>' +
      '<button type="button" class="chat-side-tab' + (state.sideTab === 'tags' ? ' is-active' : '') + '" data-chat-side-tab="tags">' + icon('hash') + L('chats.tags', 'Tags') + '</button>' +
      '</div>' +
      '<div class="chat-side-search">' +
      App.ui.searchInput.html({
        placeholder: L('chats.searchGroups', 'Search groups / tags…'),
        value: state.sideSearch,
        attrs: 'data-chat-side-search',
        class: 'is-compact',
        clearLabel: 'x',
      }) +
      '</div>' +
      '<div class="chat-side-tree" data-chat-side-tree>' + sideTopHtml() + '</div>' +
      '</div>' +
      '</div>' +
      '</aside>'
    );
  }

  function sideTopHtml() {
    if (state.sideTab === 'groups') {
      var groups = (state.config && state.config.groups) || [];
      var q = state.sideSearch.trim().toLowerCase();
      var list = groups.filter(function (g) {
        return !q || g.name.toLowerCase().indexOf(q) !== -1;
      });
      var addBtn =
        '<button type="button" class="chat-composer-btn" data-chat-group-add data-tip="' + L('chats.newGroup', 'New group') + '">' + icon('plus') + '</button>';
      return (
        '<div class="chat-side-section-head"><span>' + L('chats.groups', 'Groups') + '</span>' + addBtn + '</div>' +
        '<div class="chat-tree-list">' +
        '<button type="button" class="chat-tree-row' + (!state.groupFilter ? ' is-active' : '') + '" data-chat-group-filter="">' + icon('layers', 'size-4') + '<span>全部</span><span class="chat-tree-count">' + groupCount('') + '</span></button>' +
        (list.length
          ? list.map(function (g) {
              return (
                '<button type="button" class="chat-tree-row' + (state.groupFilter === g.id ? ' is-active' : '') + '" data-chat-group-filter="' + escAttr(g.id) + '">' +
                '<span class="chat-tree-dot" style="background:' + escAttr(g.color || 'var(--muted-foreground)') + '"></span>' +
                '<span>' + esc(g.name) + '</span><span class="chat-tree-count">' + groupCount(g.id) + '</span>' +
                '</button>'
              );
            }).join('')
          : '<div class="chat-tree-empty">' + L('chats.noGroups', 'No groups') + '</div>') +
        '</div>'
      );
    }
    var tags = (state.config && state.config.tags) || [];
    var q2 = state.sideSearch.trim().toLowerCase();
    var tlist = tags.filter(function (t) {
      return !q2 || t.name.toLowerCase().indexOf(q2) !== -1;
    });
    var addTag =
      '<button type="button" class="chat-composer-btn" data-chat-tag-add data-tip="' + L('chats.newTag', 'New tag') + '">' + icon('plus') + '</button>';
    return (
      '<div class="chat-side-section-head"><span>' + L('chats.tags', 'Tags') + '</span>' + addTag + '</div>' +
      '<div class="chat-tree-list">' +
      '<button type="button" class="chat-tree-row' + (!state.tagFilter ? ' is-active' : '') + '" data-chat-tag-filter="">' + icon('hash', 'size-4') + '<span>全部</span></button>' +
      (tlist.length
        ? tlist.map(function (t) {
            return (
              '<button type="button" class="chat-tree-row' + (state.tagFilter === t.id ? ' is-active' : '') + '" data-chat-tag-filter="' + escAttr(t.id) + '">' +
              '<span class="chat-tree-dot" style="background:' + escAttr(t.color || 'var(--muted-foreground)') + '"></span>' +
              '<span>' + esc(t.name) + '</span><span class="chat-tree-count">' + tagCount(t.id) + '</span>' +
              '</button>'
            );
          }).join('')
        : '<div class="chat-tree-empty">' + L('chats.noTags', 'No tags') + '</div>') +
      '</div>'
    );
  }

  function groupCount(gid) {
    if (gid === '') return state.conversations.filter(function (c) { return !c.archived; }).length;
    return state.conversations.filter(function (c) { return c.groupId === gid && !c.archived; }).length;
  }
  function tagCount(tid) {
    return state.conversations.filter(function (c) {
      return (c.tagIds || []).indexOf(tid) !== -1 && !c.archived;
    }).length;
  }

  function filterRowHtml() {
    var chips = [
      { id: 'all', label: L('chats.all', 'All') },
      { id: 'fav', label: L('chats.favorites', 'Favorites') },
      { id: 'pin', label: L('chats.pinned', 'Pinned') },
      { id: 'archive', label: L('chats.archived', 'Archived') },
    ];
    return (
      '<div class="chat-filter-row">' +
      chips.map(function (c) {
        return (
          '<button type="button" class="chat-filter-chip' + (state.filter === c.id ? ' is-active' : '') + '" data-chat-filter="' + c.id + '">' + c.label + '</button>'
        );
      }).join('') +
      '</div>'
    );
  }

  function convListHtml() {
    var list = filteredConversations();
    if (!list.length) return '<div class="chat-conv-empty">' + L('chats.noResults', 'No conversations') + '</div>';
    return list
      .map(function (c) {
        var tagNames = (c.tagIds || []).map(function (tid) {
          var t = (state.config.tags || []).filter(function (x) { return x.id === tid; })[0];
          return t ? t.name : '';
        }).filter(Boolean);
        return (
          '<div class="chat-conv-item' + (c.id === state.selectedId ? ' is-active' : '') + (c.archived ? ' is-archived' : '') + '" data-chat-open="' + escAttr(c.id) + '">' +
          '<button type="button" class="chat-conv-more" data-chat-conv-more="' + escAttr(c.id) + '" data-tip="更多">' + icon('ellipsis-vertical') + '</button>' +
          '<div class="chat-conv-title">' +
          (c.pinned ? '<span class="chat-conv-pin">' + icon('pin', 'size-3') + '</span>' : '') +
          (c.favorite ? '<span class="chat-conv-star" style="color:var(--chart-1)">' + icon('star', 'size-3') + '</span>' : '') +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.title || '未命名') + '</span>' +
          '</div>' +
          (c.preview ? '<div class="chat-conv-preview">' + esc(c.preview) + '</div>' : '') +
          '<div class="chat-conv-meta">' +
          '<span>' + fmtAgo(c.updatedAt || c.createdAt) + '</span>' +
          (tagNames.length ? '<span class="chat-conv-tags">' + tagNames.map(function (n) { return '<span class="chat-conv-tag">' + esc(n) + '</span>'; }).join('') + '</span>' : '') +
          '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  function filteredConversations() {
    var q = state.listSearch.trim().toLowerCase();
    var list = state.conversations.slice();
    if (state.filter === 'fav') list = list.filter(function (c) { return c.favorite; });
    else if (state.filter === 'pin') list = list.filter(function (c) { return c.pinned; });
    else if (state.filter === 'archive') list = list.filter(function (c) { return c.archived; });
    else list = list.filter(function (c) { return !c.archived; });
    if (state.groupFilter) list = list.filter(function (c) { return c.groupId === state.groupFilter; });
    if (state.tagFilter) list = list.filter(function (c) { return (c.tagIds || []).indexOf(state.tagFilter) !== -1; });
    if (q) {
      list = list.filter(function (c) {
        return (c.title || '').toLowerCase().indexOf(q) !== -1 || (c.preview || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  }

  /* ---------- 主栏 ---------- */
  function mainHtml() {
    return (
      '<section class="chat-main" data-chat-main>' +
      mainHeadHtml() +
      '<div class="chat-msgs" data-chat-msgs><div class="chat-msgs-inner">' + msgsHtml() + '</div></div>' +
      composerHtml() +
      '</section>'
    );
  }

  function mainHeadHtml() {
    var conv = state.conv;
    return (
      '<div class="chat-main-head">' +
      '<button type="button" class="chat-hamburger" data-chat-left-toggle data-tip="' + L('chats.toggleSidebar', 'Toggle sidebar') + '" aria-label="菜单">' + icon('menu') + '</button>' +
      '<button type="button" class="chat-main-title" data-chat-left-toggle data-tip="' + L('chats.toggleSidebar', 'Toggle sidebar') + '">' +
      '<span class="chat-main-name">' + esc(conv ? conv.title : L('chats.title', 'AI Chat')) + '</span>' +
      '<span class="chat-main-model">' +
      (state.active ? esc((providerById(state.active.provider) || {}).name || state.active.provider) : '') +
      (state.active && state.active.model ? '<span class="opacity-70">· ' + esc(state.active.model) + '</span>' : '') +
      (state.streaming ? '<span class="opacity-70">· 生成中…</span>' : '') +
      '</span>' +
      '</button>' +
      '<div class="chat-head-actions">' +
      (state.streaming
        ? '<button type="button" class="chat-composer-btn" data-chat-stop>' + icon('square', 'size-3') + '停止</button>'
        : '') +
      '<button type="button" class="chat-composer-btn' + (state.rightOpen ? ' is-on' : '') + '" data-chat-right-toggle data-tip="' + L('chats.parameters', 'Parameters') + '">' + icon('sliders-horizontal') + '</button>' +
      '</div>' +
      '</div>'
    );
  }

  function msgsHtml() {
    var conv = state.conv;
    if (!conv || !conv.messages.length) {
      return (
        '<div class="chat-empty">' +
        '<div class="chat-empty-icon">' + icon('sparkles', 'size-6') + '</div>' +
        '<h1>' + L('chats.emptyTitle', 'Start a new conversation') + '</h1>' +
        '<p>' + L('chats.emptyDesc', 'Pick a conversation, or just ask below.') + '</p>' +
        '</div>'
      );
    }
    return conv.messages.map(messageHtml).join('');
  }

  function messageHtml(m) {
    if (m.role === 'user') return userMessageHtml(m);
    return assistantMessageHtml(m);
  }

  function attachmentHtml(a) {
    if (a.kind === 'image') {
      var src = a.dataUrl || a.url || '';
      return src ? '<img class="chat-attach-img" src="' + escAttr(src) + '" alt="">' : '';
    }
    return (
      '<span class="chat-attach-file">' + icon('file-text') + '<span>' + esc(a.name || 'file') + '</span>' +
      (a.size ? '<span class="opacity-60">(' + fmtBytes(a.size) + ')</span>' : '') + '</span>'
    );
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function userMessageHtml(m) {
    var isEditing = state.editing && state.editing.id === m.id;
    return (
      '<div class="chat-msg-row is-user" data-msg-id="' + escAttr(m.id) + '">' +
      '<div class="chat-avatar">U</div>' +
      '<div class="chat-msg-body">' +
      ((m.attachments && m.attachments.length) ? '<div class="chat-attach-row">' + m.attachments.map(attachmentHtml).join('') + '</div>' : '') +
      '<div class="chat-bubble chat-bubble-user chat-md">' + md(m.content || '') + '</div>' +
      '<div class="chat-msg-actions">' +
      msgAction('copy', 'chats.copy', 'Copy', m.id) +
      msgAction('edit', 'chats.edit', 'Edit', m.id) +
      '</div>' +
      '<div class="chat-msg-time">' + fmtTime(m.createdAt) + '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function assistantMessageHtml(m) {
    var thinking = m.thinking || '';
    var toolCalls = m.toolCalls || [];
    var isStreaming = state.streaming && m.streaming;
    var rating = m.rating;
    var act = state.active || {};
    var thinkEnabled = !!(act.thinking && act.thinking !== 'none');
    var thinkOpen = thinkEnabled && m.thinkingOpen !== false;
    return (
      '<div class="chat-msg-row is-assistant" data-msg-id="' + escAttr(m.id) + '">' +
      '<div class="chat-avatar">AI</div>' +
      '<div class="chat-msg-body">' +
      (thinking ? thinkingBlockHtml(m.id, thinking, thinkOpen) : '') +
      (toolCalls.length ? toolCallsHtml(m.id, toolCalls) : '') +
      '<div class="chat-bubble chat-bubble-assistant' + (isStreaming ? ' is-streaming' : '') + '">' +
      '<div class="chat-md" data-chat-md>' + (m.content ? md(m.content) : (isStreaming ? '<span class="chat-caret"></span>' : '')) + '</div>' +
      (m.error ? '<div style="margin-top:0.375rem;color:var(--destructive);font-size:0.8125rem">' + esc(m.error) + '</div>' : '') +
      '</div>' +
      '<div class="chat-msg-actions">' +
      msgAction('copy', 'chats.copy', 'Copy', m.id) +
      msgAction('retry', 'chats.retry', 'Retry', m.id) +
      msgAction('good', 'chats.good', 'Good response', m.id, rating === 1) +
      msgAction('bad', 'chats.bad', 'Bad response', m.id, rating === -1) +
      '</div>' +
      '<div class="chat-msg-time">' + fmtTime(m.createdAt) + '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function msgAction(act, labelKey, fallback, msgId, isOn) {
    var cls = 'chat-msg-act';
    if (act === 'good' && isOn) cls += ' is-on';
    if (act === 'bad' && isOn) cls += ' is-bad';
    var ic = act === 'copy' ? 'copy' : act === 'edit' ? 'pencil' : act === 'retry' ? 'refresh-cw' : act === 'good' ? 'thumbs-up' : 'thumbs-down';
    return (
      '<button type="button" class="' + cls + '" data-chat-msg-act="' + act + '" data-msg-id="' + escAttr(msgId) + '" data-tip="' + L(labelKey, fallback) + '" aria-label="' + L(labelKey, fallback) + '">' + icon(ic) + '</button>'
    );
  }

  function thinkingBlockHtml(msgId, text, open) {
    return (
      '<div class="chat-thinking' + (open ? ' is-open' : '') + '" data-chat-thinking="' + escAttr(msgId) + '">' +
      '<button type="button" class="chat-thinking-head" data-chat-thinking-toggle="' + escAttr(msgId) + '">' + icon('brain', 'size-3') + L('chats.thinkingLabel', 'Thinking') +
      '<span class="chat-chev">' + icon('chevron-down') + '</span></button>' +
      '<div class="chat-thinking-body">' + esc(text) + '</div>' +
      '</div>'
    );
  }

  function toolCallsHtml(msgId, calls) {
    return (
      '<div class="chat-tools">' +
      calls.map(function (tc, i) { return toolCardHtml(msgId, i, tc); }).join('') +
      '</div>'
    );
  }
  function toolCardHtml(msgId, i, tc) {
    var status = tc.status || 'pending'; // pending / ok / err
    var statusIcon =
      status === 'ok' ? icon('circle-check', '') : status === 'err' ? icon('circle-x', '') : icon('loader-circle', '');
    return (
      '<div class="chat-tool-card' + (tc.open ? ' is-open' : '') + '" data-chat-tool-card="' + escAttr(msgId) + ':' + i + '">' +
      '<button type="button" class="chat-tool-head" data-chat-tool-toggle="' + escAttr(msgId) + ':' + i + '">' +
      '<span class="chat-tool-status is-' + status + '">' + statusIcon + '</span>' +
      '<span class="chat-tool-name">' + esc(tc.name || 'tool') + '</span>' +
      '<span class="chat-chev">' + icon('chevron-down') + '</span>' +
      '</button>' +
      '<div class="chat-tool-body">' +
      '<div class="chat-tool-label">Args</div><pre class="chat-tool-pre">' + esc(prettyJson(tc.args)) + '</pre>' +
      '<div class="chat-tool-label">Result</div><pre class="chat-tool-pre">' + esc(prettyJson(tc.output)) + '</pre>' +
      '</div>' +
      '</div>'
    );
  }
  function prettyJson(v) {
    if (v == null) return '';
    try {
      if (typeof v === 'string') return v;
      return JSON.stringify(v, null, 2);
    } catch (e) {
      return String(v);
    }
  }

  /* ---------- 输入框(Claude.ai 风格) ---------- */
  function composerHtml() {
    var active = state.active || defaults();
    var provider = providerById(active.provider);
    var models = providerModels(active.provider);
    return (
      '<div class="chat-composer-wrap">' +
      '<div class="chat-composer" data-chat-composer>' +
      (state.attachments.length ? '<div class="chat-composer-attach">' + state.attachments.map(composerAttachmentHtml).join('') + '</div>' : '') +
      '<textarea class="chat-composer-textarea" data-chat-textarea rows="1" placeholder="' + L('chats.typeMessage', 'Type a message…') + '">' + esc(state.input) + '</textarea>' +
      '<div class="chat-composer-bar">' +
      '<div class="chat-composer-left">' +
      composerDd('provider', provider ? esc(provider.name) : L('chats.selectProvider', 'Provider'), composerProviderMenu(active)) +
      composerDd('model', active.model ? esc(active.model) : L('chats.selectModel', 'Model'), composerModelMenu(active, models)) +
      thinkingDepthHtml(active) +
      '<button type="button" class="chat-composer-btn' + (thinkingOn(active) ? ' is-on' : '') + '" data-chat-toggle="thinking" data-tip="' + L('chats.thinkingLabel', 'Thinking') + '">' + icon('brain') + '</button>' +
      mcpComposerHtml(active) +
      '</div>' +
      '<div class="chat-composer-right">' +
      imageAttachHtml() +
      fileAttachHtml() +
      webComposerHtml(active) +
      '<button type="button" class="chat-send-btn" data-chat-send ' + (canSend() ? '' : 'disabled') + ' aria-label="' + L('chats.send', 'Send') + '">' +
      (state.streaming ? icon('loader-circle', 'size-4') : icon('arrow-up', 'size-4')) +
      '</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<input type="file" hidden accept="image/*" data-chat-image-input>' +
      '<input type="file" hidden multiple data-chat-file-input>' +
      '</div>'
    );
  }

  function composerAttachmentHtml(a, idx) {
    var inner =
      a.kind === 'image' && (a.dataUrl || a.url)
        ? '<img src="' + escAttr(a.dataUrl || a.url) + '" alt="">'
        : icon('file-text');
    return (
      '<span class="chat-attach-chip">' + inner + '<span>' + esc(a.name || '') + '</span>' +
      '<button type="button" class="chat-attach-x" data-chat-del-attach="' + idx + '" aria-label="remove">' + icon('x') + '</button>' +
      '</span>'
    );
  }

  function thinkingOn(active) {
    return !!(active.thinking && active.thinking !== 'none');
  }

  var THINK_LEVELS = ['low', 'medium', 'high', 'max'];
  function thinkLevelLabel(level) {
    var map = { low: '低', medium: '中', high: '高', max: '最高' };
    var en = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
    return map[level] || en[level] || level;
  }
  function thinkingDepthHtml(active) {
    if (!thinkingOn(active)) return '';
    var cur = active.thinking || 'medium';
    var items = THINK_LEVELS.map(function (lv) {
      return ddItem('depth', lv, thinkLevelLabel(lv), lv === cur);
    }).join('');
    return composerDd('depth', thinkLevelLabel(cur), items);
  }

  function composerDd(kind, label, menuHtml) {
    return (
      '<div class="chat-dd">' +
      '<button type="button" class="chat-composer-btn" data-chat-dd-trigger="' + kind + '" data-tip="' + escAttr(label) + '">' +
      '<span class="chat-btn-value">' + label + '</span>' + icon('chevron-down', 'size-3') +
      '</button>' +
      '<div class="chat-dd-menu" data-chat-dd-menu="' + kind + '">' + menuHtml + '</div>' +
      '</div>'
    );
  }

  function composerProviderMenu(active) {
    return (
      '<div class="chat-dd-label">内置供应商</div>' +
      builtinProviders().map(function (pr) { return ddItem('provider', pr.id, pr.name, active.provider === pr.id); }).join('') +
      (customProviders().length
        ? '<div class="chat-dd-label">自定义</div>' + customProviders().map(function (pr) { return ddItem('provider', pr.id, pr.name, active.provider === pr.id); }).join('')
        : '')
    );
  }

  function composerModelMenu(active, models) {
    return (
      '<button type="button" class="chat-dd-item" data-chat-input-model><span style="color:var(--muted-foreground)">手动输入模型名…</span></button>' +
      (models.length
        ? models.map(function (m) { return ddItem('model', m, m, active.model === m); }).join('')
        : '<div class="chat-dd-label">' + L('chats.modelHint', '在右侧参数面板点「获取模型」') + '</div>')
    );
  }

  function mcpComposerHtml(active) {
    var mcp = (state.config && state.config.mcp) || [];
    return (
      '<div class="chat-dd">' +
      '<button type="button" class="chat-composer-btn' + (active.mcpEnabled ? ' is-on' : '') + '" data-chat-dd-trigger="mcp" data-tip="' + L('chats.mcp', 'MCP tools') + '">' + icon('plug-zap') + '</button>' +
      '<div class="chat-dd-menu" data-chat-dd-menu="mcp" style="min-width:16rem;max-width:20rem">' +
      '<div class="chat-dd-label">' + L('chats.mcp', 'MCP tools') + '</div>' +
      '<button type="button" class="chat-dd-item" data-chat-toggle="mcp"><span>' + L('chats.mcpEnabled', 'Enable MCP') + '</span>' + (active.mcpEnabled ? '<span class="chat-dd-check">' + icon('check') + '</span>' : '') + '</button>' +
      (mcp.length ? mcp.map(mcpComposerServerHtml).join('') : '<div class="chat-dd-label">' + L('chats.noMcp', '暂无 MCP,请在设置中添加') + '</div>') +
      '</div>' +
      '</div>'
    );
  }

  function mcpComposerServerHtml(s) {
    return (
      '<div class="chat-mcp-pop">' +
      '<div class="chat-mcp-pop-server">' +
      '<span class="chat-switch' + (s.enabled ? ' is-on' : '') + '" data-chat-mcp-toggle="' + escAttr(s.id) + '"></span>' +
      '<span class="chat-mcp-pop-name">' + esc(s.name || s.id) + '</span>' +
      '<span class="chat-mcp-badge">' + esc(s.protocol === 'sse' ? 'sse' : 'http') + '</span>' +
      '</div>' +
      ((s.tools && s.tools.length)
        ? s.tools.map(function (t) {
            var disabled = !s.enabled;
            return (
              '<div class="chat-mcp-pop-tool' + (disabled ? ' is-disabled' : '') + '">' +
              '<span class="chat-switch' + (t.enabled && !disabled ? ' is-on' : '') + '" data-chat-mcp-tool-toggle="' + escAttr(s.id) + ':' + escAttr(t.name) + '"></span>' +
              '<span class="chat-mcp-pop-toolname">' + esc(t.name || 'tool') + '</span>' +
              '</div>'
            );
          }).join('')
        : '<div class="chat-mcp-pop-tool is-empty">' + (s.enabled ? '发送时自动发现工具' : '未启用') + '</div>') +
      '</div>'
    );
  }

  function imageAttachHtml() {
    return (
      '<div class="chat-dd">' +
      '<button type="button" class="chat-composer-btn" data-chat-dd-trigger="image" data-tip="' + L('chats.insertImage', 'Insert image') + '">' + icon('image') + '</button>' +
      '<div class="chat-dd-menu" data-chat-dd-menu="image" style="min-width:12rem">' +
      '<button type="button" class="chat-dd-item" data-chat-attach="upload-image">' + icon('upload') + '<span>上传本地图片</span></button>' +
      '<button type="button" class="chat-dd-item" data-chat-attach="url-image">' + icon('link') + '<span>远程图片 URL</span></button>' +
      '</div>' +
      '</div>'
    );
  }

  function fileAttachHtml() {
    return (
      '<div class="chat-dd">' +
      '<button type="button" class="chat-composer-btn" data-chat-dd-trigger="file" data-tip="' + L('chats.insertFile', 'Insert file') + '">' + icon('paperclip') + '</button>' +
      '<div class="chat-dd-menu" data-chat-dd-menu="file" style="min-width:12rem">' +
      '<button type="button" class="chat-dd-item" data-chat-attach="upload-file">' + icon('upload') + '<span>上传本地文件</span></button>' +
      '<button type="button" class="chat-dd-item" data-chat-attach="url-file">' + icon('link') + '<span>远程文件 URL</span></button>' +
      '</div>' +
      '</div>'
    );
  }

  function webComposerHtml(active) {
    return (
      '<div class="chat-dd">' +
      '<button type="button" class="chat-composer-btn' + (active.webSearch ? ' is-on' : '') + '" data-chat-dd-trigger="web" data-tip="' + L('chats.webSearch', 'Web search') + '">' + icon('globe') + '</button>' +
      '<div class="chat-dd-menu" data-chat-dd-menu="web" style="min-width:13rem">' +
      '<div class="chat-dd-label">' + L('chats.searchProvider', 'Search provider') + '</div>' +
      '<button type="button" class="chat-dd-item" data-chat-toggle="web"><span>' + L('chats.webSearch', 'Enable web search') + '</span>' + (active.webSearch ? '<span class="chat-dd-check">' + icon('check') + '</span>' : '') + '</button>' +
      ['duckduckgo', 'serper', 'tavily', 'bing', 'google'].map(function (sp) {
        return (
          '<button type="button" class="chat-dd-item' + (active.webSearchProvider === sp ? ' is-active' : '') + '" data-chat-set-webprovider="' + sp + '">' +
          '<span>' + esc(sp) + '</span>' + (active.webSearchProvider === sp ? '<span class="chat-dd-check">' + icon('check') + '</span>' : '') + '</button>'
        );
      }).join('') +
      '</div>' +
      '</div>'
    );
  }

  function thinkingLabel(v) {
    var map = { none: '关闭', low: '低', medium: '中', high: '高' };
    return (map[v] || v);
  }
  function canSend() {
    return !state.streaming && !!(state.input.trim() || state.attachments.length);
  }

  /* ---------- 右栏 ---------- */
  function rightHtml() {
    return (
      '<aside class="chat-right' + (state.rightOpen ? '' : ' is-collapsed') + (state.rightOpen ? ' is-open' : '') + '" data-chat-right>' +
      '<div class="chat-right-head">' +
      '<div class="chat-right-title">' + L('chats.parameters', 'Parameters') + '</div>' +
      '<button type="button" class="chat-composer-btn" data-chat-right-toggle>' + icon('x') + '</button>' +
      '</div>' +
      '<div class="chat-right-tabs">' +
      rightTabBtn('params', 'sliders-horizontal', L('chats.parameters', 'Params')) +
      rightTabBtn('mcp', 'plug-zap', L('chats.mcp', 'MCP')) +
      rightTabBtn('agent', 'bot', L('chats.agent', 'Agent')) +
      '</div>' +
      '<div class="chat-right-body">' + rightBodyHtml() + '</div>' +
      '</aside>'
    );
  }
  function rightTabBtn(id, ic, label) {
    return (
      '<button type="button" class="chat-right-tab' + (state.rightTab === id ? ' is-active' : '') + '" data-chat-right-tab="' + id + '">' + icon(ic) + label + '</button>'
    );
  }
  function rightBodyHtml() {
    if (state.rightTab === 'mcp') return mcpHtml();
    if (state.rightTab === 'agent') return agentHtml();
    return paramsHtml();
  }

  function paramsHtml() {
    var a = state.active || defaults();
    var p = a.params || {};
    var provider = providerById(a.provider);
    var models = providerModels(a.provider);
    var prompts = (state.config && state.config.prompts) || [];
    var curPrompt = prompts.filter(function (x) { return x.id === a.promptId; })[0];
    var modelLoading = state.models[a.provider] && state.models[a.provider].loading;

    return (
      fieldHtml(L('chats.provider', 'Provider'),
        ddMenu('provider', provider ? provider.name : L('chats.selectProvider', 'Select provider'),
          '<div class="chat-dd-label">内置供应商</div>' +
          builtinProviders().map(function (pr) { return ddItem('provider', pr.id, pr.name, a.provider === pr.id); }).join('') +
          (customProviders().length ? '<div class="chat-dd-label">自定义</div>' + customProviders().map(function (pr) { return ddItem('provider', pr.id, pr.name, a.provider === pr.id); }).join('') : '') +
          '<button type="button" class="chat-dd-item" data-chat-add-provider>' + icon('plus') + '<span>' + L('chats.addProvider', 'Add provider') + '</span></button>'
        ) +
        '<div style="margin-top:0.375rem">' +
        '<input type="password" class="chat-input" placeholder="API Key" value="' + escAttr(providerKey(a.provider)) + '" data-chat-apikey="' + escAttr(a.provider) + '">' +
        '</div>'
      ) +
      fieldHtml(L('chats.model', 'Model'),
        '<div class="chat-select-row">' +
        ddMenu('model', a.model || L('chats.selectModel', 'Select model'),
          '<div class="chat-dd-label">' + L('chats.model', 'Model') + '</div>' +
          '<button type="button" class="chat-dd-item" data-chat-input-model><span style="color:var(--muted-foreground)">手动输入模型名…</span></button>' +
          (models.length ? models.map(function (m) { return ddItem('model', m, m, a.model === m); }).join('') : '<div class="chat-dd-label">' + (provider && provider.id === 'lmstudio' ? '本地模型请手动输入' : '点击下方按钮获取模型列表') + '</div>')
        ) +
        '<button type="button" class="chat-btn" data-chat-fetch-models title="' + L('chats.fetchModels', 'Fetch models') + '">' + (modelLoading ? icon('loader-circle', 'size-4') : icon('refresh-cw', 'size-4')) + '<span>' + L('chats.fetchModels', '获取模型') + '</span></button>' +
        '</div>'
      ) +
      sliderField(L('chats.temperature', 'Temperature'), 'temperature', 0, 2, 0.05, p.temperature, function (v) { return Number(v).toFixed(2); }) +
      sliderField(L('chats.topP', 'Top P'), 'topP', 0, 1, 0.01, p.topP, function (v) { return Number(v).toFixed(2); }) +
      sliderField(L('chats.topK', 'Top K'), 'topK', 0, 100, 1, p.topK, function (v) { return String(Math.round(v)); }) +
      fieldHtml(L('chats.maxTokens', 'Max tokens'),
        '<div class="chat-select-row">' +
        '<input type="text" class="chat-input" value="' + escAttr(formatMaxTokens(p.maxTokens)) + '" data-chat-maxtokens>' +
        ddMenu('maxtokens', '',
          '<div class="chat-dd-label">常用值</div>' +
          [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 393216, 524288, 1048576, 2097152].map(function (v) {
            return ddItem('maxtokens', String(v), formatMaxTokens(v), false);
          }).join('')
        ) +
        '</div>'
      ) +
      fieldHtml(L('chats.prompt', 'Prompt'),
        ddMenu('prompt', curPrompt ? curPrompt.name : '默认',
          '<button type="button" class="chat-dd-item' + (!a.promptId ? ' is-active' : '') + '" data-chat-set-prompt="">' + icon('message-square') + '<span>默认(无系统提示)</span>' + (!a.promptId ? '<span class="chat-dd-check">' + icon('check') + '</span>' : '') + '</button>' +
          prompts.map(function (pr) { return ddItem('prompt', pr.id, pr.name, a.promptId === pr.id); }).join('') +
          '<div class="chat-dd-sep"></div>' +
          '<button type="button" class="chat-dd-item" data-chat-add-prompt>' + icon('plus') + '<span>' + L('chats.newPrompt', 'New prompt') + '</span></button>' +
          '<button type="button" class="chat-dd-item" data-chat-manage-prompts>' + icon('list') + '<span>' + L('chats.managePrompts', 'Manage prompts') + '</span></button>'
        ) +
        '<div style="margin-top:0.375rem;font-size:0.6875rem;color:var(--muted-foreground)">' +
        (curPrompt ? esc(curPrompt.content.slice(0, 90)) + (curPrompt.content.length > 90 ? '…' : '') : '') +
        '</div>' +
        (curPrompt && curPrompt.id !== 'p-default' ? '<div class="chat-btn-row" style="margin-top:0.375rem"><button type="button" class="chat-btn" data-chat-prompt-edit="' + escAttr(curPrompt.id) + '">' + icon('pencil') + L('chats.edit', 'Edit') + '</button><button type="button" class="chat-btn is-danger" data-chat-prompt-del="' + escAttr(curPrompt.id) + '">' + icon('trash') + L('chats.delete', 'Delete') + '</button></div>' : '')
      )
    );
  }

  function fieldHtml(label, control) {
    return (
      '<div class="chat-field">' +
      '<div class="chat-field-label"><span>' + label + '</span></div>' +
      control +
      '</div>'
    );
  }
  function sliderField(label, param, min, max, step, value, fmt) {
    var pct = ((value - min) / (max - min)) * 100;
    return (
      '<div class="chat-field">' +
      '<div class="chat-field-label"><span>' + label + '</span><span class="chat-field-val">' + fmt(value) + '</span></div>' +
      '<div class="chat-range-row">' +
      '<div class="chat-slider" data-chat-slider="' + param + '" data-min="' + min + '" data-max="' + max + '" data-step="' + step + '" data-value="' + value + '">' +
      '<div class="chat-slider-track"><div class="chat-slider-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="chat-slider-thumb" style="left:' + pct + '%"></div>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function ddMenu(kind, label, items) {
    return (
      '<div class="chat-dd" data-chat-dd-wrap>' +
      '<button type="button" class="chat-select" data-chat-dd-trigger="' + kind + '">' +
      '<span class="chat-select-val">' + label + '</span><span class="chat-chev">' + icon('chevron-down', 'size-3') + '</span>' +
      '</button>' +
      '<div class="chat-dd-menu" data-chat-dd-menu="' + kind + '">' + items + '</div>' +
      '</div>'
    );
  }
  function ddItem(kind, value, label, active) {
    return (
      '<button type="button" class="chat-dd-item' + (active ? ' is-active' : '') + '" data-chat-set-' + kind + '="' + escAttr(value) + '">' +
      '<span>' + esc(label) + '</span>' + (active ? '<span class="chat-dd-check">' + icon('check') + '</span>' : '') +
      '</button>'
    );
  }

  /* ---------- MCP ---------- */
  /* ---------- MCP ---------- */
  function mcpHtml() {
    var list = (state.config && state.config.mcp) || [];
    return (
      '<div class="chat-mcp-hint">' + L('chats.mcpHint', '') + '</div>' +
      (list.length
        ? list.map(mcpItemHtml).join('')
        : '<div class="chat-mcp-empty">' + L('chats.noMcp', '暂无 MCP 服务器') + '</div>') +
      '<button type="button" class="chat-btn chat-btn-block" data-chat-add-mcp>' + icon('plus') + L('chats.addMcp', 'Add MCP') + '</button>'
    );
  }

  function mcpItemHtml(s) {
    var tools = (s.tools || []).filter(function (t) { return t && t.name; });
    var open = state.mcpOpen[s.id] !== false;
    var busy = state.mcpBusy === s.id;
    return (
      '<div class="chat-mcp-item' + (s.enabled ? '' : ' is-off') + '">' +
      '<div class="chat-mcp-head">' +
      '<div class="chat-mcp-title">' +
      '<span class="chat-mcp-name">' + esc(s.name || s.id) + '</span>' +
      '<span class="chat-mcp-badge">' + esc(s.protocol === 'sse' ? 'sse' : 'http') + '</span>' +
      '</div>' +
      '<button type="button" class="chat-switch' + (s.enabled ? ' is-on' : '') + '" data-chat-mcp-toggle="' + escAttr(s.id) + '" aria-label="toggle"></button>' +
      '</div>' +
      '<div class="chat-mcp-url">' + esc(s.url || '') + '</div>' +
      '<div class="chat-mcp-actions">' +
      '<button type="button" class="chat-btn chat-btn-sm" data-chat-mcp-fetch="' + escAttr(s.id) + '">' + (busy ? '<span class="chat-spin">' + icon('refresh-cw') + '</span>' : icon('refresh-cw')) + L('chats.fetchTools', '拉取工具列表') + '</button>' +
      '<button type="button" class="chat-btn chat-btn-sm" data-chat-mcp-edit="' + escAttr(s.id) + '">' + icon('pencil') + L('chats.edit', '编辑') + '</button>' +
      '<button type="button" class="chat-btn chat-btn-sm is-danger" data-chat-mcp-del="' + escAttr(s.id) + '">' + icon('trash') + L('chats.delete', '删除') + '</button>' +
      '</div>' +
      '<button type="button" class="chat-mcp-tools-head' + (open ? ' is-open' : '') + '" data-chat-mcp-toggle-tools="' + escAttr(s.id) + '">' +
      '<span class="chat-mcp-chevron">' + icon('chevron-right') + '</span>' +
      '<span>' + L('chats.availableTools', '可用工具') + '（' + tools.length + '）</span>' +
      '</button>' +
      (open
        ? '<div class="chat-mcp-tools">' +
          (tools.length
            ? tools.map(function (t) {
                var disabled = !s.enabled;
                return (
                  '<div class="chat-mcp-tool' + (disabled ? ' is-disabled' : '') + '">' +
                  '<div class="chat-mcp-tool-name">' + esc(t.name || 'tool') + (t.description ? '<div class="chat-mcp-tool-desc">' + esc(t.description) + '</div>' : '') + '</div>' +
                  '<button type="button" class="chat-switch' + (t.enabled && !disabled ? ' is-on' : '') + '" ' + (disabled ? 'disabled' : '') + ' data-chat-mcp-tool-toggle="' + escAttr(s.id) + ':' + escAttr(t.name) + '" aria-label="tool"></button>' +
                  '</div>'
                );
              }).join('')
            : '<div class="chat-mcp-tool is-empty">' + (s.enabled ? L('chats.fetchToolsHint', '点击「拉取工具列表」获取该服务器的工具') : L('chats.disabled', '未启用')) + '</div>') +
          '</div>'
        : '') +
      '</div>'
    );
  }

  function agentHtml() {
    return (
      '<div class="chat-empty" style="margin-top:4rem">' +
      '<div class="chat-empty-icon">' + icon('bot', 'size-6') + '</div>' +
      '<p style="color:var(--muted-foreground)">' + L('chats.agentPlaceholder', 'Agent placeholder') + '</p>' +
      '</div>'
    );
  }

  /* ---------- 弹窗 ---------- */
  function dialogHtml() {
    if (!state.dialog) return '';
    var d = state.dialog;
    var title = '';
    var body = '';
    var footExtra = '';
    if (d.kind === 'provider') {
      title = d.id ? '编辑供应商' : L('chats.customProvider', 'Custom provider');
      body =
        fieldHtml('名称', '<input type="text" class="chat-input" data-dlg-field="name" value="' + escAttr(d.name || '') + '" placeholder="My Provider">') +
        fieldHtml('Base URL', '<input type="text" class="chat-input" data-dlg-field="baseUrl" value="' + escAttr(d.baseUrl || '') + '" placeholder="https://api.example.com/v1">') +
        fieldHtml('API Key', '<input type="password" class="chat-input" data-dlg-field="apiKey" value="' + escAttr(d.apiKey || '') + '" placeholder="sk-…(兼容 chat/completions)">') +
        fieldHtml('默认模型(逗号分隔)', '<input type="text" class="chat-input" data-dlg-field="models" value="' + escAttr((d.models || []).join(', ')) + '" placeholder="model-a, model-b">');
    } else if (d.kind === 'mcp') {
      title = d.id ? '编辑 MCP' : L('chats.addMcp', 'Add MCP');
      var mcpProto = d.protocol || 'https';
      var mcpEnabled = d.enabled !== false;
      body =
        fieldHtml(L('chats.name', 'Name'), '<input type="text" class="chat-input" data-dlg-field="name" value="' + escAttr(d.name || '') + '" placeholder="context7">') +
        fieldHtml(L('chats.protocol', 'Transport'),
          '<div class="chat-select-row">' +
          '<button type="button" class="chat-select" data-dlg-protocol="https"><span class="chat-select-val">Streamable HTTP</span>' + (mcpProto !== 'sse' ? '<span class="chat-chev">' + icon('check', 'size-3') + '</span>' : '') + '</button>' +
          '<button type="button" class="chat-select" data-dlg-protocol="sse"><span class="chat-select-val">SSE (HTTP+SSE)</span>' + (mcpProto === 'sse' ? '<span class="chat-chev">' + icon('check', 'size-3') + '</span>' : '') + '</button>' +
          '</div>') +
        fieldHtml(L('chats.url', 'Server URL'), '<input type="text" class="chat-input" data-dlg-field="url" value="' + escAttr(d.url || '') + '" placeholder="https://…/mcp">') +
        fieldHtml(L('chats.apiKeyOptional', 'API Key (optional)'),
          '<input type="password" class="chat-input" data-dlg-field="apiKey" value="' + escAttr(d.apiKey || '') + '" placeholder="' + L('chats.apiKeyEmpty', 'Leave empty for no auth') + '" autocomplete="off">' +
          '<div class="chat-field-desc">' + L('chats.apiKeyHint', 'Sent as Bearer token in the Authorization header') + '</div>') +
        fieldHtml(L('chats.authHeader', 'Auth header'),
          '<input type="text" class="chat-input" data-dlg-field="authHeader" value="' + escAttr(d.authHeader || '') + '" placeholder="Authorization">' +
          '<div class="chat-field-desc">' + L('chats.authHeaderHint', 'Leave empty to use Authorization; or set a custom header name (e.g. x-api-key)') + '</div>') +
        fieldHtml(L('chats.customHeaders', 'Custom headers'),
          '<div class="chat-hdrs">' +
          mcpHeaderRowsHtml(d) +
          '<button type="button" class="chat-btn" data-dlg-add-hdr>' + icon('plus', 'size-3') + L('chats.addHeader', 'Add header') + '</button>' +
          '</div>') +
        fieldHtml(L('chats.sort', 'Sort weight'), '<input type="number" class="chat-input" data-dlg-field="sort" value="' + escAttr(d.sort != null ? d.sort : 0) + '" placeholder="0">') +
        fieldHtml(L('chats.enableServer', 'Enable this server'),
          '<span role="switch" aria-checked="' + mcpEnabled + '" class="chat-switch' + (mcpEnabled ? ' is-on' : '') + '" data-dlg-enabled></span>');
    } else if (d.kind === 'prompt') {
      title = d.id ? L('chats.editPrompt', 'Edit prompt') : L('chats.newPrompt', 'New prompt');
      body =
        fieldHtml(L('chats.name', 'Name'), '<input type="text" class="chat-input" data-dlg-field="name" value="' + escAttr(d.name || '') + '" placeholder="React 工程师">') +
        fieldHtml(L('chats.content', 'Content'), '<textarea class="chat-textarea" data-dlg-field="content" placeholder="系统提示词…">' + esc(d.content || '') + '</textarea>');
    } else if (d.kind === 'prompt-manage') {
      title = L('chats.managePrompts', 'Manage prompts');
      var pmList = (state.config.prompts || []).map(function (p) {
        return (
          '<div class="chat-pm-row">' +
          '<div class="chat-pm-main"><div class="chat-pm-name">' + esc(p.name || p.id) + '</div>' +
          '<div class="chat-pm-desc">' + esc((p.content || '').slice(0, 80)) + '</div></div>' +
          '<div class="chat-pm-acts">' +
          '<button type="button" class="chat-btn" data-prompt-mgmt-edit="' + escAttr(p.id) + '">' + icon('pencil', 'size-3') + L('chats.edit', 'Edit') + '</button>' +
          '<button type="button" class="chat-btn is-danger" data-prompt-mgmt-del="' + escAttr(p.id) + '">' + icon('trash', 'size-3') + L('chats.delete', 'Delete') + '</button>' +
          '</div></div>'
        );
      }).join('');
      body = pmList || '<p class="sp-field-desc" style="color:var(--muted-foreground)">' + L('chats.noPrompts', 'No prompts yet') + '</p>';
      footExtra =
        '<button type="button" class="chat-btn is-primary" data-prompt-mgmt-new>' + icon('plus', 'size-3') + L('chats.newPrompt', 'New prompt') + '</button>';
    } else if (d.kind === 'group') {
      title = d.id ? '编辑分组' : L('chats.newGroup', 'New group');
      body =
        fieldHtml(L('chats.name', 'Name'), '<input type="text" class="chat-input" data-dlg-field="name" value="' + escAttr(d.name || '') + '" placeholder="工作">') +
        fieldHtml(L('chats.color', 'Color'), '<input type="text" class="chat-input" data-dlg-field="color" value="' + escAttr(d.color || '') + '" placeholder="#3b82f6">');
    } else if (d.kind === 'tag') {
      title = d.id ? '编辑标签' : L('chats.newTag', 'New tag');
      body =
        fieldHtml(L('chats.name', 'Name'), '<input type="text" class="chat-input" data-dlg-field="name" value="' + escAttr(d.name || '') + '" placeholder="重要">') +
        fieldHtml(L('chats.color', 'Color'), '<input type="text" class="chat-input" data-dlg-field="color" value="' + escAttr(d.color || '') + '" placeholder="#ef4444">');
    } else if (d.kind === 'url') {
      title = d.urlKind === 'image' ? '远程图片 URL' : '远程文件 URL';
      body = fieldHtml('URL', '<input type="text" class="chat-input" data-dlg-field="url" placeholder="https://…">');
    } else if (d.kind === 'rename') {
      title = L('chats.rename', 'Rename');
      body = fieldHtml(L('chats.name', 'Name'), '<input type="text" class="chat-input" data-dlg-field="name" value="' + escAttr(d.name || '') + '">');
    } else if (d.kind === 'confirm') {
      title = d.title || L('chats.confirmDelete', 'Confirm');
      body = '<p style="font-size:0.875rem;color:var(--muted-foreground)">' + esc(d.message || '') + '</p>';
    } else if (d.kind === 'model-input') {
      title = L('chats.model', 'Model');
      body = fieldHtml(L('chats.model', 'Model name'), '<input type="text" class="chat-input" data-dlg-field="model" value="' + escAttr(d.value || '') + '" placeholder="model-name">');
    }
    return (
      '<div class="chat-overlay" data-chat-dlg-backdrop>' +
      '<div class="chat-dialog" data-chat-dialog>' +
      '<div class="chat-dialog-head"><h2>' + esc(title) + '</h2><button type="button" class="chat-composer-btn" data-chat-dlg-close>' + icon('x') + '</button></div>' +
      '<div class="chat-dialog-body">' + body + '</div>' +
      '<div class="chat-dialog-foot">' +
      (footExtra || '') +
      '<button type="button" class="chat-btn" data-chat-dlg-close>' + L('chats.cancel', 'Cancel') + '</button>' +
      (d.kind === 'prompt-manage' ? '' : '<button type="button" class="chat-btn is-primary" data-chat-dlg-save>' + (d.kind === 'confirm' ? (d.confirmLabel || L('chats.delete', 'Delete')) : L('chats.save', 'Save')) + '</button>') +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function mcpHeaderRowsHtml(d) {
    var hdrs = {};
    var h = d.headers && typeof d.headers === 'object' ? d.headers : {};
    Object.keys(h).forEach(function (k) {
      if (k.toLowerCase() === 'authorization') return; // Authorization 由 API Key 字段管理
      hdrs[k] = h[k];
    });
    var keys = Object.keys(hdrs);
    if (!keys.length) keys = [''];
    return keys.map(function (k, i) {
      return (
        '<div class="chat-hdr-row">' +
        '<input type="text" class="chat-input" data-dlg-hkey="' + i + '" value="' + escAttr(k) + '" placeholder="Header 名">' +
        '<input type="text" class="chat-input" data-dlg-hval="' + i + '" value="' + escAttr(hdrs[k] || '') + '" placeholder="值">' +
        '<button type="button" class="chat-composer-btn" data-dlg-del-hdr="' + i + '" aria-label="remove">' + icon('x') + '</button>' +
        '</div>'
      );
    }).join('');
  }

  function openDialog(kind, payload) {
    state.dialog = Object.assign({ kind: kind }, payload || {});
    rerender();
  }
  function closeDialog() {
    state.dialog = null;
    rerender();
  }
  function dlgField(name) {
    var el = document.querySelector('[data-chat-dialog] [data-dlg-field="' + name + '"]');
    return el ? el.value : '';
  }

  /* ---------- 上下文菜单 ---------- */
  function ctxHtml() {
    if (!state.ctx) return '';
    var c = state.ctx;
    var conv = state.conversations.filter(function (x) { return x.id === c.id; })[0];
    if (!conv) return '';
    var items = [];
    if (conv.favorite) items.push(ctxItem('unfav', icon('star'), L('chats.unfavorite', 'Unfavorite')));
    else items.push(ctxItem('fav', icon('star'), L('chats.favorite', 'Favorite')));
    if (conv.pinned) items.push(ctxItem('unpin', icon('pin'), L('chats.unpin', 'Unpin')));
    else items.push(ctxItem('pin', icon('pin'), L('chats.pin', 'Pin')));
    if (conv.archived) items.push(ctxItem('unarchive', icon('archive'), L('chats.unarchive', 'Unarchive')));
    else items.push(ctxItem('archive', icon('archive'), L('chats.archive', 'Archive')));
    items.push(ctxItem('rename', icon('pencil'), L('chats.rename', 'Rename')));
    items.push(ctxItem('move', icon('folder'), L('chats.moveTo', 'Move to group')));
    items.push(ctxItem('tag', icon('hash'), L('chats.addTag', 'Add tag')));
    items.push('<div class="chat-ctx-sep"></div>');
    items.push(ctxItem('delete', icon('trash'), L('chats.delete', 'Delete'), 'is-danger'));
    return (
      '<div class="chat-ctx" style="left:' + c.x + 'px;top:' + c.y + 'px" data-chat-ctx>' +
      items.join('') +
      '</div>'
    );
  }
  function ctxItem(action, ic, label, extra) {
    return (
      '<button type="button" class="chat-dd-item' + (extra ? ' ' + extra : '') + '" data-chat-ctx="' + action + '">' + ic + '<span>' + label + '</span></button>'
    );
  }
  function openCtx(id, x, y) {
    // 防止菜单溢出视口
    x = Math.min(x, window.innerWidth - 200);
    y = Math.min(y, window.innerHeight - 260);
    state.ctx = { id: id, x: x, y: y };
    rerender();
  }
  function closeCtx() {
    if (state.ctx) {
      state.ctx = null;
      rerender();
    }
  }

  /* ============================================================
   * 流式对话
   * ============================================================ */
  function apiMessages(conv) {
    var out = [];
    conv.messages.forEach(function (m) {
      if (m.role === 'user') {
        var text = m.content || '';
        var atts = m.attachments || [];
        var fileTexts = [];
        atts.forEach(function (a) {
          if (a.kind === 'file' && a.text) fileTexts.push('【文件 ' + (a.name || '') + '】\n' + a.text);
          else if (a.kind === 'file' && a.url) fileTexts.push('【文件链接】' + a.url);
        });
        if (fileTexts.length) text = (text ? text + '\n\n' : '') + fileTexts.join('\n\n');
        var images = atts.filter(function (a) { return a.kind === 'image' && (a.dataUrl || a.url); });
        if (images.length) {
          var parts = [{ type: 'text', text: text }];
          images.forEach(function (a) {
            parts.push({ type: 'image_url', image_url: { url: a.dataUrl || a.url } });
          });
          out.push({ role: 'user', content: parts });
        } else {
          out.push({ role: 'user', content: text });
        }
      } else if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: m.content || '' });
      }
    });
    return out;
  }

  function sendMessage() {
    if (!canSend()) return;
    var text = state.input;
    var atts = state.attachments.slice();
    state.input = '';
    state.attachments = [];
    state.editing = null;

    var conv = state.conv;
    if (!conv) {
      conv = {
        id: uid('conv'),
        title: text.slice(0, 40) || '新对话',
        groupId: state.groupFilter || '',
        tagIds: state.tagFilter ? [state.tagFilter] : [],
        favorite: false, pinned: false, archived: false,
        provider: state.active.provider, model: state.active.model,
        promptId: state.active.promptId, params: Object.assign({}, state.active.params),
        messages: [], createdAt: nowIso(), updatedAt: nowIso(),
      };
      state.conv = conv;
      state.selectedId = conv.id;
      state.conversations.unshift({
        id: conv.id, title: conv.title, groupId: conv.groupId, tagIds: conv.tagIds,
        favorite: false, pinned: false, archived: false, preview: text.slice(0, 80),
        messageCount: 0, provider: conv.provider, model: conv.model, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
      });
    }
    conv.messages.push({ id: uid('m'), role: 'user', content: text, attachments: atts, createdAt: nowIso() });
    conv.updatedAt = nowIso();
    conv.title = conv.title || text.slice(0, 40);
    startAssistantStream(conv);
  }

  function startAssistantStream(conv) {
    var asst = { id: uid('m'), role: 'assistant', content: '', thinking: '', toolCalls: [], createdAt: nowIso(), streaming: true };
    conv.messages.push(asst);
    state.streaming = true;
    state.streamConvId = conv.id;
    state.abortCtrl = new AbortController();
    rerender();
    scrollMsgsToBottom();
    var payload = {
      providerId: state.active.provider,
      model: state.active.model,
      promptId: state.active.promptId,
      params: state.active.params,
      thinking: state.active.thinking,
      webSearch: state.active.webSearch,
      webSearchProvider: state.active.webSearchProvider,
      mcpEnabled: state.active.mcpEnabled,
      messages: apiMessages(conv),
    };
    var token = App.auth.token();
    fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token, 'Cache-Control': 'no-store' },
      body: JSON.stringify(payload),
      signal: state.abortCtrl.signal,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (txt) {
            var msg = txt;
            try {
              var j = JSON.parse(txt);
              msg = j.message || j.error || txt;
            } catch (e) {}
            throw new Error(msg || 'HTTP ' + res.status);
          });
        }
        return res.body.getReader();
      })
      .then(function (reader) {
        var decoder = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              finalizeStream(conv, asst);
              return;
            }
            buf += decoder.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              var raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              var data = raw
                .split('\n')
                .filter(function (l) { return l.indexOf('data:') === 0; })
                .map(function (l) { return l.slice(5).trim(); })
                .join('');
              if (!data) continue;
              var ev;
              try { ev = JSON.parse(data); } catch (e) { continue; }
              handleStreamEvent(ev, conv, asst);
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') {
          asst.content = asst.content || '';
          finalizeStream(conv, asst, true);
          return;
        }
        asst.error = (e && e.message) || String(e);
        finalizeStream(conv, asst);
      });
  }

  function handleStreamEvent(ev, conv, asst) {
    if (ev.type === 'delta') {
      asst.content = (asst.content || '') + ev.text;
      scheduleMdRender(asst.id, asst.content);
    } else if (ev.type === 'thinking') {
      asst.thinking = (asst.thinking || '') + ev.text;
      updateThinking(asst.id, asst.thinking);
    } else if (ev.type === 'tool_start') {
      var tc = { id: ev.id, name: ev.name, args: {}, output: '', status: 'pending' };
      asst.toolCalls.push(tc);
      appendToolCard(asst.id, asst.toolCalls.length - 1, tc);
    } else if (ev.type === 'tool_arg') {
      // 参数实时追加(可忽略,args 在 tool_end 补齐)
    } else if (ev.type === 'tool_end') {
      var t2 = asst.toolCalls.filter(function (x) { return x.id === ev.id; })[0];
      if (t2) {
        t2.name = ev.name || t2.name;
        t2.args = ev.args || {};
        updateToolCard(asst.id, t2);
      }
    } else if (ev.type === 'tool_result') {
      var t3 = asst.toolCalls.filter(function (x) { return x.id === ev.id; })[0];
      if (t3) {
        t3.status = ev.ok ? 'ok' : 'err';
        t3.output = ev.output != null ? ev.output : ev.error;
        updateToolCard(asst.id, t3);
      }
    } else if (ev.type === 'error') {
      asst.error = ev.message;
    }
    scrollMsgsToBottom();
  }

  function finalizeStream(conv, asst, aborted) {
    asst.streaming = false;
    delete asst.streaming;
    if (aborted && !asst.content && !asst.thinking) {
      asst.content = '已停止。';
    }
    if (!asst.content && !asst.thinking && !asst.toolCalls.length && !asst.error) {
      asst.error = asst.error || '无响应内容';
    }
    conv.updatedAt = nowIso();
    state.streaming = false;
    state.streamConvId = null;
    if (state.abortCtrl) {
      try { state.abortCtrl = null; } catch (e) {}
    }
    saveConversation(conv);
    rerender();
    scrollMsgsToBottom();
  }

  function scheduleMdRender(msgId, text) {
    var el = document.querySelector('[data-msg-id="' + msgId + '"] [data-chat-md]');
    if (!el) return;
    el._pendingText = text;
    if (el._timer) return;
    var now = Date.now();
    if (now - (el._last || 0) < 40) {
      el._timer = setTimeout(function () {
        el._timer = null;
        doMdRender(el);
      }, 40);
    } else {
      doMdRender(el);
    }
  }
  function doMdRender(el) {
    el._last = Date.now();
    el.innerHTML = md(el._pendingText || '') + '<span class="chat-caret"></span>';
  }
  function updateThinking(msgId, text) {
    var root = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!root) return;
    var block = root.querySelector('[data-chat-thinking]');
    if (!block) {
      // 思维链块动态插入到气泡之前
      var bubble = root.querySelector('.chat-bubble');
      var tmp = document.createElement('div');
      tmp.innerHTML = thinkingBlockHtml(msgId, text, true);
      bubble.parentNode.insertBefore(tmp.firstChild, bubble);
    } else {
      block.classList.add('is-open');
      var body = block.querySelector('.chat-thinking-body');
      if (body) body.textContent = text;
    }
  }
  function appendToolCard(msgId, index, tc) {
    var root = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!root) return;
    var tools = root.querySelector('.chat-tools');
    if (!tools) {
      var bubble = root.querySelector('.chat-bubble');
      var tmp = document.createElement('div');
      tmp.innerHTML = '<div class="chat-tools"></div>';
      tools = tmp.firstChild;
      bubble.parentNode.insertBefore(tools, bubble);
    }
    var card = document.createElement('div');
    card.innerHTML = toolCardHtml(msgId, index, tc);
    tools.appendChild(card.firstChild);
  }
  function updateToolCard(msgId, tc) {
    var root = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!root) return;
    var cards = root.querySelectorAll('[data-chat-tool-card]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var nameEl = card.querySelector('.chat-tool-name');
      if (nameEl && nameEl.textContent === tc.name) {
        card.innerHTML = toolCardHtml(msgId, i, tc);
        return;
      }
    }
    // 名字可能尚未匹配到(工具名空)→ 重绘整块
    rerenderMain();
  }

  function stopStream() {
    if (state.abortCtrl) {
      try { state.abortCtrl.abort(); } catch (e) {}
    }
  }

  /* ============================================================
   * 下拉 / 弹层控制
   * ============================================================ */
  function closeDds() {
    document.querySelectorAll('.chat-dd-menu.is-open').forEach(function (m) {
      m.classList.remove('is-open');
      if (m.style.position === 'fixed') {
        m.style.position = '';
        m.style.left = '';
        m.style.top = '';
        m.style.bottom = '';
        m.style.width = '';
      }
    });
  }
  function toggleDd(trigger) {
    var wrap = trigger.closest('.chat-dd');
    if (!wrap) return;
    var menu = wrap.querySelector('[data-chat-dd-menu]');
    if (!menu) return;
    var wasOpen = menu.classList.contains('is-open');
    closeDds();
    if (wasOpen) return;
    menu.classList.add('is-open');
    var rect = wrap.getBoundingClientRect();
    // 右侧面板(滚动容器)内的菜单用 fixed 定位,避免被 overflow 裁剪;
    // 其余(输入框等)保持绝对定位 + 向上弹出
    if (wrap.closest('.chat-right')) {
      var estH = Math.min(menu.scrollHeight || 320, 320);
      menu.style.position = 'fixed';
      menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 330)) + 'px';
      menu.style.width = Math.min(Math.max(rect.width, 240), 320) + 'px';
      menu.style.marginTop = '0';
      menu.style.marginBottom = '0';
      if (rect.bottom + estH > window.innerHeight - 8 && rect.top > estH) {
        menu.style.top = 'auto';
        menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      } else {
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.bottom = 'auto';
      }
      return;
    }
    if (rect.bottom > window.innerHeight * 0.6) {
      menu.style.bottom = '100%';
      menu.style.top = 'auto';
      menu.style.marginBottom = '4px';
    } else {
      menu.style.top = '100%';
      menu.style.bottom = 'auto';
      menu.style.marginTop = '4px';
    }
  }

  /* ============================================================
   * 事件委托
   * ============================================================ */
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    // 下拉触发器
    var ddTrigger = target.closest('[data-chat-dd-trigger]');
    if (ddTrigger) {
      e.stopPropagation();
      toggleDd(ddTrigger);
      return;
    }

    // 上下文菜单动作
    var ctxItemEl = target.closest('[data-chat-ctx]');
    if (ctxItemEl) {
      var act = ctxItemEl.getAttribute('data-chat-ctx');
      var cid = state.ctx ? state.ctx.id : null;
      closeCtx();
      handleCtxAction(act, cid);
      return;
    }
    if (!target.closest('[data-chat-ctx]')) closeCtx();

    // 弹窗
    if (target.closest('[data-chat-dlg-close]') || target.closest('[data-chat-dlg-backdrop]')) {
      closeDialog();
      return;
    }
    if (target.closest('[data-chat-dlg-save]')) {
      saveDialog();
      return;
    }
    if (target.closest('[data-dlg-protocol]')) {
      var pr = target.closest('[data-dlg-protocol]');
      state.dialog.protocol = pr.getAttribute('data-dlg-protocol');
      rerender();
      return;
    }
    if (target.closest('[data-dlg-enabled]')) {
      state.dialog.enabled = state.dialog.enabled === false;
      rerender();
      return;
    }
    if (target.closest('[data-dlg-add-hdr]')) {
      var hdrsWrap = document.querySelector('.chat-hdrs');
      if (hdrsWrap) {
        var hdrIdx = hdrsWrap.querySelectorAll('.chat-hdr-row').length;
        var hdrDiv = document.createElement('div');
        hdrDiv.className = 'chat-hdr-row';
        hdrDiv.innerHTML =
          '<input type="text" class="chat-input" data-dlg-hkey="' + hdrIdx + '" placeholder="Header 名">' +
          '<input type="text" class="chat-input" data-dlg-hval="' + hdrIdx + '" placeholder="值">' +
          '<button type="button" class="chat-composer-btn" data-dlg-del-hdr="' + hdrIdx + '" aria-label="remove">' + icon('x') + '</button>';
        hdrsWrap.insertBefore(hdrDiv, hdrsWrap.lastElementChild);
      }
      return;
    }
    if (target.closest('[data-dlg-del-hdr]')) {
      var hdrRow = target.closest('.chat-hdr-row');
      if (hdrRow && hdrRow.parentNode) hdrRow.parentNode.removeChild(hdrRow);
      return;
    }

    // 汉堡 / 抽屉
    if (target.closest('[data-chat-left-toggle]')) {
      state.leftOpen = !state.leftOpen;
      state.scrim = isMobileLayout() && (state.leftOpen || state.rightOpen);
      rerender();
      return;
    }
    if (target.closest('[data-chat-right-toggle]')) {
      state.rightOpen = !state.rightOpen;
      state.scrim = isMobileLayout() && (state.leftOpen || state.rightOpen);
      rerender();
      return;
    }
    if (target.closest('[data-chat-scrim]')) {
      state.leftOpen = false;
      state.rightOpen = false;
      state.scrim = false;
      rerender();
      return;
    }

    // 新对话 / 打开会话
    if (target.closest('[data-chat-new]')) {
      newConversation();
      return;
    }
    var open = target.closest('[data-chat-open]');
    if (open) {
      selectConversation(open.getAttribute('data-chat-open'));
      return;
    }
    var more = target.closest('[data-chat-conv-more]');
    if (more) {
      e.stopPropagation();
      var mid = more.getAttribute('data-chat-conv-more');
      openCtx(mid, e.clientX, e.clientY);
      return;
    }

    // 侧栏 tab / 过滤
    var st = target.closest('[data-chat-side-tab]');
    if (st) {
      state.sideTab = st.getAttribute('data-chat-side-tab');
      state.sideSearch = '';
      rerender();
      return;
    }
    var flt = target.closest('[data-chat-filter]');
    if (flt) {
      state.filter = flt.getAttribute('data-chat-filter');
      rerender();
      return;
    }
    var gf = target.closest('[data-chat-group-filter]');
    if (gf) {
      state.groupFilter = gf.getAttribute('data-chat-group-filter') || null;
      rerender();
      return;
    }
    var tf = target.closest('[data-chat-tag-filter]');
    if (tf) {
      state.tagFilter = tf.getAttribute('data-chat-tag-filter') || null;
      rerender();
      return;
    }

    // 右栏 tab
    var rt = target.closest('[data-chat-right-tab]');
    if (rt) {
      state.rightTab = rt.getAttribute('data-chat-right-tab');
      rerenderRight();
      return;
    }

    // 下拉选项
    var setProvider = target.closest('[data-chat-set-provider]');
    if (setProvider) {
      setActiveParam('provider', setProvider.getAttribute('data-chat-set-provider'));
      if (!state.active.model) {
        var pm = providerModels(state.active.provider);
        setActiveParam('model', pm && pm.length ? pm[0] : '');
      }
      closeDds();
      rerender();
      return;
    }
    var setModel = target.closest('[data-chat-set-model]');
    if (setModel) {
      setActiveParam('model', setModel.getAttribute('data-chat-set-model'));
      closeDds();
      rerender();
      return;
    }
    if (target.closest('[data-chat-input-model]')) {
      var cur = state.active.model;
      var entered = window.prompt ? null : null;
      // 使用行内弹窗代替原生 prompt(AGENTS 禁用原生控件)
      openDialog('model-input', { value: cur });
      closeDds();
      return;
    }
    var setPrompt = target.closest('[data-chat-set-prompt]');
    if (setPrompt) {
      setActiveParam('promptId', setPrompt.getAttribute('data-chat-set-prompt'));
      closeDds();
      rerender();
      return;
    }
    var setWeb = target.closest('[data-chat-set-webprovider]');
    if (setWeb) {
      setActiveParam('webSearchProvider', setWeb.getAttribute('data-chat-set-webprovider'));
      setActiveParam('webSearch', true);
      closeDds();
      rerender();
      return;
    }
    var setMax = target.closest('[data-chat-set-maxtokens]');
    if (setMax) {
      setActiveParamDeep('maxTokens', parseInt(setMax.getAttribute('data-chat-set-maxtokens'), 10));
      closeDds();
      rerender();
      return;
    }
    var setThinking = target.closest('[data-chat-set-thinking]');
    if (setThinking) {
      setActiveParam('thinking', setThinking.getAttribute('data-chat-set-thinking'));
      closeDds();
      rerender();
      return;
    }
    var setDepth = target.closest('[data-chat-set-depth]');
    if (setDepth) {
      setActiveParam('thinking', setDepth.getAttribute('data-chat-set-depth'));
      closeDds();
      rerender();
      return;
    }

    // 开关
    var toggle = target.closest('[data-chat-toggle]');
    if (toggle) {
      var what = toggle.getAttribute('data-chat-toggle');
      if (what === 'mcp') setActiveParam('mcpEnabled', !state.active.mcpEnabled);
      else if (what === 'web') setActiveParam('webSearch', !state.active.webSearch);
      else if (what === 'thinking') setActiveParam('thinking', (state.active.thinking && state.active.thinking !== 'none') ? 'none' : 'medium');
      rerender();
      return;
    }

    // 获取模型
    if (target.closest('[data-chat-fetch-models]')) {
      fetchModels(state.active.provider);
      return;
    }

    // 消息动作
    var msgAct = target.closest('[data-chat-msg-act]');
    if (msgAct) {
      var mAct = msgAct.getAttribute('data-chat-msg-act');
      var mId = msgAct.getAttribute('data-msg-id');
      handleMsgAction(mAct, mId);
      return;
    }

    // 思维链 / 工具卡折叠
    var thinkT = target.closest('[data-chat-thinking-toggle]');
    if (thinkT) {
      var thRoot = thinkT.closest('[data-chat-thinking]');
      if (thRoot) {
        var thOpen = !thRoot.classList.contains('is-open');
        thRoot.classList.toggle('is-open');
        if (state.conv) {
          var thId = thinkT.getAttribute('data-chat-thinking-toggle');
          var thMsg = state.conv.messages.filter(function (m) { return m.id === thId; })[0];
          if (thMsg) thMsg.thinkingOpen = thOpen;
        }
      }
      return;
    }
    var toolT = target.closest('[data-chat-tool-toggle]');
    if (toolT) {
      var card = toolT.closest('[data-chat-tool-card]');
      if (card) {
        card.classList.toggle('is-open');
        var key = card.getAttribute('data-chat-tool-card');
        if (state.conv) {
          var parts = key.split(':');
          var mi = state.conv.messages.filter(function (m) { return m.id === parts[0]; })[0];
          if (mi && mi.toolCalls && mi.toolCalls[+parts[1]]) mi.toolCalls[+parts[1]].open = !mi.toolCalls[+parts[1]].open;
        }
      }
      return;
    }

    // 代码复制
    var codeCopy = target.closest('[data-chat-code-copy]');
    if (codeCopy) {
      var pre = codeCopy.closest('pre');
      if (pre) copyText(pre.querySelector('code') ? pre.querySelector('code').textContent : '');
      return;
    }

    // 发送 / 停止
    if (target.closest('[data-chat-send]')) {
      sendMessage();
      return;
    }
    if (target.closest('[data-chat-stop]')) {
      stopStream();
      return;
    }

    // 附件
    var attach = target.closest('[data-chat-attach]');
    if (attach) {
      var aKind = attach.getAttribute('data-chat-attach');
      if (aKind === 'upload-image') {
        var ii = document.querySelector('[data-chat-image-input]');
        if (ii) ii.click();
      } else if (aKind === 'upload-file') {
        var fi = document.querySelector('[data-chat-file-input]');
        if (fi) fi.click();
      } else if (aKind === 'url-image') {
        openDialog('url', { urlKind: 'image' });
      } else if (aKind === 'url-file') {
        openDialog('url', { urlKind: 'file' });
      }
      closeDds();
      return;
    }
    var delAtt = target.closest('[data-chat-del-attach]');
    if (delAtt) {
      var idx = parseInt(delAtt.getAttribute('data-chat-del-attach'), 10);
      state.attachments.splice(idx, 1);
      rerender();
      return;
    }

    // MCP 开关 / 编辑 / 删除
    var mcpT = target.closest('[data-chat-mcp-toggle]');
    if (mcpT) {
      toggleMcpEnabled(mcpT.getAttribute('data-chat-mcp-toggle'));
      return;
    }
    var mcpTool = target.closest('[data-chat-mcp-tool-toggle]');
    if (mcpTool) {
      toggleMcpTool(mcpTool.getAttribute('data-chat-mcp-tool-toggle'));
      return;
    }
    var mcpFetch = target.closest('[data-chat-mcp-fetch]');
    if (mcpFetch) {
      fetchMcpTools(mcpFetch.getAttribute('data-chat-mcp-fetch'));
      return;
    }
    var mcpToolsT = target.closest('[data-chat-mcp-toggle-tools]');
    if (mcpToolsT) {
      var mtId = mcpToolsT.getAttribute('data-chat-mcp-toggle-tools');
      state.mcpOpen[mtId] = state.mcpOpen[mtId] === false ? true : false;
      rerender();
      return;
    }
    if (target.closest('[data-chat-add-mcp]')) {
      openDialog('mcp', { protocol: 'https', enabled: true });
      return;
    }
    var mcpEdit = target.closest('[data-chat-mcp-edit]');
    if (mcpEdit) {
      var me = (state.config.mcp || []).filter(function (s) { return s.id === mcpEdit.getAttribute('data-chat-mcp-edit'); })[0];
      if (me) openDialog('mcp', Object.assign({}, me));
      return;
    }
    var mcpDel = target.closest('[data-chat-mcp-del]');
    if (mcpDel) {
      var mdId = mcpDel.getAttribute('data-chat-mcp-del');
      state.config.mcp = (state.config.mcp || []).filter(function (s) { return s.id !== mdId; });
      persistConfig();
      rerender();
      return;
    }

    // 供应商 / 提示词 / 分组 / 标签
    if (target.closest('[data-chat-add-provider]')) {
      closeDds();
      openDialog('provider', {});
      return;
    }
    var provEdit = target.closest('[data-chat-provider-edit]');
    if (provEdit) {
      var pe = customProviders().filter(function (p) { return p.id === provEdit.getAttribute('data-chat-provider-edit'); })[0];
      if (pe) openDialog('provider', Object.assign({}, pe, { apiKey: providerKey(pe.id) }));
      return;
    }
    var provDel = target.closest('[data-chat-provider-del]');
    if (provDel) {
      var pdId = provDel.getAttribute('data-chat-provider-del');
      state.config.providers = (state.config.providers || []).filter(function (p) { return p.id !== pdId; });
      if (state.active.provider === pdId) setActiveParam('provider', 'opencode-go');
      persistConfig();
      rerender();
      return;
    }
    if (target.closest('[data-chat-add-prompt]')) {
      closeDds();
      openDialog('prompt', {});
      return;
    }
    var managePrompts = target.closest('[data-chat-manage-prompts]');
    if (managePrompts) {
      closeDds();
      openDialog('prompt-manage', {});
      return;
    }
    if (target.closest('[data-prompt-mgmt-new]')) {
      openDialog('prompt', {});
      return;
    }
    var pmEdit = target.closest('[data-prompt-mgmt-edit]');
    if (pmEdit) {
      var pme = (state.config.prompts || []).filter(function (p) { return p.id === pmEdit.getAttribute('data-prompt-mgmt-edit'); })[0];
      if (pme) openDialog('prompt', Object.assign({}, pme));
      return;
    }
    var pmDel = target.closest('[data-prompt-mgmt-del]');
    if (pmDel) {
      var pmdId = pmDel.getAttribute('data-prompt-mgmt-del');
      state.config.prompts = (state.config.prompts || []).filter(function (p) { return p.id !== pmdId; });
      if (state.active.promptId === pmdId) setActiveParam('promptId', '');
      persistConfig();
      App.ui.toast(L('chats.deleted', 'Deleted'));
      openDialog('prompt-manage', {});
      return;
    }
    var promptEdit = target.closest('[data-chat-prompt-edit]');
    if (promptEdit) {
      var pr = (state.config.prompts || []).filter(function (p) { return p.id === promptEdit.getAttribute('data-chat-prompt-edit'); })[0];
      if (pr) openDialog('prompt', Object.assign({}, pr));
      return;
    }
    var promptDel = target.closest('[data-chat-prompt-del]');
    if (promptDel) {
      var prId = promptDel.getAttribute('data-chat-prompt-del');
      state.config.prompts = (state.config.prompts || []).filter(function (p) { return p.id !== prId });
      if (state.active.promptId === prId) setActiveParam('promptId', '');
      persistConfig();
      rerender();
      return;
    }
    if (target.closest('[data-chat-group-add]')) {
      openDialog('group', {});
      return;
    }
    if (target.closest('[data-chat-tag-add]')) {
      openDialog('tag', {});
      return;
    }

    // 点击外部关闭下拉与上下文菜单
    closeDds();
  });

  function handleCtxAction(act, id) {
    var conv = state.conversations.filter(function (c) { return c.id === id; })[0];
    if (!conv) return;
    if (act === 'fav' || act === 'unfav') toggleConvFlag(id, 'favorite');
    else if (act === 'pin' || act === 'unpin') toggleConvFlag(id, 'pinned');
    else if (act === 'archive' || act === 'unarchive') toggleConvFlag(id, 'archived');
    else if (act === 'rename') openDialog('rename', { id: id, name: conv.title });
    else if (act === 'move') openDialog('move', { id: id });
    else if (act === 'tag') openDialog('tagpick', { id: id });
    else if (act === 'delete') openDialog('confirm', {
      id: id,
      title: L('chats.confirmDelete', 'Confirm delete'),
      message: L('chats.deleteConfirmMsg', 'Delete this conversation?'),
      confirmLabel: L('chats.delete', 'Delete'),
    });
  }

  function handleMsgAction(act, id) {
    var conv = state.conv;
    if (!conv) return;
    var hit = findMsg(conv, id);
    if (!hit) return;
    var m = hit.msg;
    if (act === 'copy') {
      var txt = m.content || '';
      if (m.toolCalls && m.toolCalls.length) {
        txt += '\n\n[工具调用]\n' + m.toolCalls.map(function (t) { return '- ' + t.name; }).join('\n');
      }
      copyText(txt);
    } else if (act === 'edit') {
      if (m.role !== 'user') return;
      state.editing = { id: m.id };
      state.input = m.content || '';
      state.attachments = (m.attachments || []).slice();
      rerender();
      focusComposer();
    } else if (act === 'retry') {
      if (m.role !== 'assistant') return;
      conv.messages.splice(hit.index, 1);
      conv.updatedAt = nowIso();
      startAssistantStream(conv);
    } else if (act === 'good' || act === 'bad') {
      if (m.role !== 'assistant') return;
      var next = act === 'good' ? 1 : -1;
      m.rating = m.rating === next ? null : next;
      saveConversation(conv);
      rerender();
    }
  }

  function toggleMcpEnabled(id) {
    var list = state.config.mcp || [];
    var s = list.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    s.enabled = !s.enabled;
    persistConfig();
    rerender();
  }
  function toggleMcpTool(key) {
    var parts = key.split(':');
    var s = (state.config.mcp || []).filter(function (x) { return x.id === parts[0]; })[0];
    if (!s || !s.enabled) return;
    var t = (s.tools || []).filter(function (x) { return x.name === parts[1]; })[0];
    if (t) t.enabled = t.enabled === false;
    persistConfig();
    rerender();
  }

  function fetchMcpTools(id) {
    var entry = (state.config.mcp || []).filter(function (s) { return s.id === id; })[0];
    if (!entry) return;
    state.mcpBusy = id;
    rerender();
    App.api
      .post('/api/chat/mcp/tools', {
        url: entry.url,
        protocol: entry.protocol,
        headers: entry.headers,
        apiKey: entry.apiKey,
        authHeader: entry.authHeader,
      })
      .then(function (data) {
        var tools = (data && data.tools) || [];
        state.config.mcp = (state.config.mcp || []).map(function (s) {
          if (s.id !== id) return s;
          return Object.assign({}, s, {
            tools: tools.map(function (tt) {
              var old = (s.tools || []).filter(function (x) { return x.name === tt.name; })[0];
              return { name: tt.name, description: tt.description || '', enabled: old ? old.enabled !== false : true };
            }),
          });
        });
        state.mcpBusy = null;
        state.mcpOpen[id] = true;
        persistConfig();
        rerender();
        App.ui.toast(L('chats.toolsFetched', '已获取工具') + ': ' + tools.length);
      })
      .catch(function (e) {
        state.mcpBusy = null;
        rerender();
        App.ui.toast(L('chats.toolsFetchFailed', '获取工具失败') + ': ' + ((e && e.message) || e), 'error');
      });
  }

  function fetchModels(providerId) {
    state.models[providerId] = { loading: true };
    rerenderRight();
    if (!state.dialog) rerender(); // 更新输入框中的模型下拉
    App.api
      .post('/api/chat/models', { providerId: providerId })
      .then(function (data) {
        state.models[providerId] = { loading: false, list: data.models || [] };
        // 若当前未选模型,自动选第一个
        if (!state.active.model && data.models && data.models.length) {
          setActiveParam('model', data.models[0]);
        }
        rerenderRight();
        rerender();
      })
      .catch(function (e) {
        state.models[providerId] = { loading: false, list: state.models[providerId] ? state.models[providerId].list : [] };
        App.ui.toast(L('chats.modelFetchFailed', 'Failed to fetch models') + ': ' + (e && e.message), 'error');
        rerenderRight();
      });
  }

  function saveDialog() {
    var d = state.dialog;
    if (!d) return;
    if (d.kind === 'provider') {
      var name = dlgField('name').trim();
      var baseUrl = dlgField('baseUrl').trim();
      var apiKey = dlgField('apiKey').trim();
      var models = dlgField('models').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!name || !baseUrl) {
        App.ui.toast('名称与 Base URL 必填', 'error');
        return;
      }
      var id = d.id || 'cust-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      var exists = customProviders().filter(function (p) { return p.id === id; })[0];
      var entry = { id: id, name: name, baseUrl: baseUrl, kind: 'openai', models: models, multimodal: true };
      if (exists) {
        state.config.providers = state.config.providers.map(function (p) { return p.id === id ? entry : p; });
      } else {
        state.config.providers.push(entry);
      }
      if (apiKey) {
        state.secrets.providerKeys = state.secrets.providerKeys || {};
        state.secrets.providerKeys[id] = apiKey;
      }
      setActiveParam('provider', id);
      persistConfig();
      App.ui.toast(L('chats.saved', 'Saved'));
      closeDialog();
    } else if (d.kind === 'mcp') {
      var mn = dlgField('name').trim();
      var mu = dlgField('url').trim();
      if (!mu) {
        App.ui.toast('URL 必填', 'error');
        return;
      }
      var mcpId = d.id || uid('mcp');
      var mcpKey = dlgField('apiKey').trim();
      var mcpAuthHdr = dlgField('authHeader').trim();
      var mcpSort = parseInt(dlgField('sort') || '0', 10);
      if (!isFinite(mcpSort)) mcpSort = 0;
      var mcpHdrs = {};
      document.querySelectorAll('[data-chat-dialog] .chat-hdr-row').forEach(function (r) {
        var hk = r.querySelector('[data-dlg-hkey]');
        var hv = r.querySelector('[data-dlg-hval]');
        if (hk && hv && hk.value.trim()) mcpHdrs[hk.value.trim()] = hv.value;
      });
      var entryM = { id: mcpId, name: mn || mcpId, url: mu, protocol: d.protocol || 'https', enabled: d.enabled !== false, apiKey: mcpKey, authHeader: mcpAuthHdr, sort: mcpSort, headers: mcpHdrs, tools: d.tools || [] };
      var mExists = (state.config.mcp || []).filter(function (s) { return s.id === mcpId; })[0];
      if (mExists) {
        state.config.mcp = state.config.mcp.map(function (s) { return s.id === mcpId ? Object.assign({}, s, entryM, { tools: s.tools || [] }) : s; });
      } else {
        state.config.mcp = (state.config.mcp || []).concat([entryM]);
      }
      persistConfig();
      App.ui.toast(L('chats.saved', 'Saved'));
      closeDialog();
      // 异步拉取工具列表
      refreshMcpTools(mcpId, mu, d.protocol || 'https');
    } else if (d.kind === 'prompt') {
      var pn = dlgField('name').trim();
      var pc = dlgField('content').trim();
      if (!pn) {
        App.ui.toast('名称必填', 'error');
        return;
      }
      var pid = d.id || uid('p');
      var pe = { id: pid, name: pn, content: pc, sort: 0 };
      var pExists = (state.config.prompts || []).filter(function (p) { return p.id === pid; })[0];
      if (pExists) state.config.prompts = state.config.prompts.map(function (p) { return p.id === pid ? pe : p; });
      else state.config.prompts = (state.config.prompts || []).concat([pe]);
      persistConfig();
      App.ui.toast(L('chats.saved', 'Saved'));
      closeDialog();
    } else if (d.kind === 'group') {
      var gn = dlgField('name').trim();
      if (!gn) {
        App.ui.toast('名称必填', 'error');
        return;
      }
      var gc = dlgField('color').trim() || '#3b82f6';
      var gid = d.id || uid('g');
      var ge = { id: gid, name: gn, color: gc, parentId: '', sort: 0 };
      var gExists = (state.config.groups || []).filter(function (g) { return g.id === gid; })[0];
      if (gExists) state.config.groups = state.config.groups.map(function (g) { return g.id === gid ? ge : g; });
      else state.config.groups = (state.config.groups || []).concat([ge]);
      persistConfig();
      App.ui.toast(L('chats.saved', 'Saved'));
      closeDialog();
    } else if (d.kind === 'tag') {
      var tn = dlgField('name').trim();
      if (!tn) {
        App.ui.toast('名称必填', 'error');
        return;
      }
      var tc = dlgField('color').trim() || '#ef4444';
      var tid = d.id || uid('t');
      var te = { id: tid, name: tn, color: tc, sort: 0 };
      var tExists = (state.config.tags || []).filter(function (t) { return t.id === tid; })[0];
      if (tExists) state.config.tags = state.config.tags.map(function (t) { return t.id === tid ? te : t; });
      else state.config.tags = (state.config.tags || []).concat([te]);
      persistConfig();
      App.ui.toast(L('chats.saved', 'Saved'));
      closeDialog();
    } else if (d.kind === 'url') {
      var u = dlgField('url').trim();
      if (!u) return;
      if (d.urlKind === 'image') {
        state.attachments.push({ id: uid('a'), kind: 'image', name: u.slice(0, 40), url: u, mime: 'image/*', size: 0 });
      } else {
        state.attachments.push({ id: uid('a'), kind: 'file', name: u.slice(0, 40), url: u, mime: '', size: 0 });
      }
      closeDialog();
      rerender();
      focusComposer();
    } else if (d.kind === 'rename') {
      var rn = dlgField('name').trim();
      if (!rn) return;
      patchConv(d.id, { title: rn });
      App.ui.toast(L('chats.saved', 'Saved'));
      closeDialog();
    } else if (d.kind === 'move') {
      // 移动到分组由 group 选择弹窗完成(此处简化:直接选择)
      closeDialog();
    } else if (d.kind === 'tagpick') {
      closeDialog();
    } else if (d.kind === 'confirm') {
      closeDialog();
      deleteConv([d.id]);
    } else if (d.kind === 'model-input') {
      var mv = dlgField('model').trim();
      if (mv) setActiveParam('model', mv);
      closeDialog();
    }
  }

  function refreshMcpTools(id, url, protocol) {
    // 后端没有独立 MCP 工具列表接口时,通过临时调用:这里使用本地 tools/list 代理
    // 为保持简单,直接重新加载配置(服务端已存 tools 由编辑时保留)
    // 真正的工具发现发生在流式调用时(服务端 MCP 客户端按需 listTools)
    App.ui.toast('MCP 已保存(工具在发送消息时自动发现)');
  }

  /* ---------- 输入事件 ---------- */
  document.addEventListener('input', function (e) {
    var target = e.target;
    if (!target || !target.getAttribute) return;
    if (target.hasAttribute('data-chat-list-search')) {
      state.listSearch = target.value;
      rerenderList();
      return;
    }
    if (target.hasAttribute('data-chat-side-search')) {
      state.sideSearch = target.value;
      var tree = document.querySelector('[data-chat-side-tree]');
      if (tree) tree.outerHTML = sideTopHtml();
      return;
    }
    if (target.hasAttribute('data-chat-textarea')) {
      state.input = target.value;
      autoGrow(target);
      updateSendBtn();
      return;
    }
    if (target.hasAttribute('data-chat-maxtokens')) {
      var v = parseMaxTokens(target.value);
      if (v != null) {
        setActiveParamDeep('maxTokens', v);
        target.value = formatMaxTokens(v);
      }
      return;
    }
    if (target.hasAttribute('data-chat-apikey')) {
      var prov = target.getAttribute('data-chat-apikey');
      var key = target.value.trim();
      state.secrets.providerKeys = state.secrets.providerKeys || {};
      if (key) state.secrets.providerKeys[prov] = key;
      else delete state.secrets.providerKeys[prov];
      persistConfig();
      return;
    }
  });

  document.addEventListener('change', function (e) {
    var target = e.target;
    if (!target || !target.getAttribute) return;
    if (target.hasAttribute('data-chat-file-input') || target.hasAttribute('data-chat-image-input')) {
      handleFiles(target.files);
      target.value = '';
    }
  });

  document.addEventListener('keydown', function (e) {
    var target = e.target;
    if (!target || !target.hasAttribute) return;
    if (e.key === 'Escape') {
      closeCtx();
      closeDds();
      return;
    }
    if (target.hasAttribute('data-chat-textarea')) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend()) sendMessage();
      }
    }
  });

  document.addEventListener('paste', function (e) {
    var target = e.target;
    if (!target || !target.hasAttribute || !target.hasAttribute('data-chat-textarea')) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var images = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.type && it.type.indexOf('image/') === 0 && it.getAsFile) {
        var f = it.getAsFile();
        if (f) images.push(f);
      }
    }
    if (!images.length) {
      // 文本过长自动生成 txt 附件
      var text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (text.length > 4000) {
        e.preventDefault();
        state.attachments.push({
          id: uid('a'), kind: 'file', name: 'pasted-' + Date.now() + '.txt', mime: 'text/plain',
          size: text.length, text: text,
        });
        rerender();
      }
      return;
    }
    e.preventDefault();
    images.forEach(function (f) {
      readFileAsDataUrl(f, function (dataUrl) {
        state.attachments.push({ id: uid('a'), kind: 'image', name: f.name || 'pasted.png', mime: f.type, size: f.size, dataUrl: dataUrl });
        rerender();
      });
    });
  });

  /* ---------- 自定义滑块(替代原生 range) ---------- */
  document.addEventListener('pointerdown', function (e) {
    var sl = e.target.closest ? e.target.closest('[data-chat-slider]') : null;
    if (!sl) return;
    e.preventDefault();
    state.dragSlider = {
      param: sl.getAttribute('data-chat-slider'),
      min: parseFloat(sl.getAttribute('data-min')),
      max: parseFloat(sl.getAttribute('data-max')),
      step: parseFloat(sl.getAttribute('data-step')),
    };
    sliderFromEvent(sl, e);
  });
  document.addEventListener('pointermove', function (e) {
    if (!state.dragSlider) return;
    var sl = document.querySelector('[data-chat-slider="' + state.dragSlider.param + '"]');
    if (sl) sliderFromEvent(sl, e);
  });
  document.addEventListener('pointerup', function () {
    state.dragSlider = null;
  });

  function sliderFromEvent(sl, e) {
    var d = state.dragSlider;
    if (!d) return;
    var track = sl.querySelector('.chat-slider-track');
    if (!track) return;
    var rect = track.getBoundingClientRect();
    var ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.max(0, Math.min(1, ratio));
    var val = d.min + ratio * (d.max - d.min);
    val = Math.round(val / d.step) * d.step;
    val = Math.max(d.min, Math.min(d.max, val));
    sl.setAttribute('data-value', val);
    var pct = ((val - d.min) / (d.max - d.min)) * 100;
    var fill = sl.querySelector('.chat-slider-fill');
    var thumb = sl.querySelector('.chat-slider-thumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
    setActiveParamDeep(d.param, val);
    var label = sl.closest('.chat-field');
    if (label) {
      var num = label.querySelector('.chat-field-val');
      if (num) num.textContent = d.param === 'temperature' || d.param === 'topP' ? Number(val).toFixed(2) : String(Math.round(val));
    }
  }

  /* ---------- 附件处理 ---------- */
  function handleFiles(files) {
    Array.prototype.forEach.call(files || [], function (f) {
      if (f.type && f.type.indexOf('image/') === 0) {
        readFileAsDataUrl(f, function (dataUrl) {
          state.attachments.push({ id: uid('a'), kind: 'image', name: f.name, mime: f.type, size: f.size, dataUrl: dataUrl });
          rerender();
        });
      } else if (f.type && (f.type.indexOf('text/') === 0 || /\.(txt|md|json|js|ts|css|html|xml|csv|py|log)$/i.test(f.name))) {
        var reader = new FileReader();
        reader.onload = function () {
          state.attachments.push({ id: uid('a'), kind: 'file', name: f.name, mime: f.type, size: f.size, text: String(reader.result || '') });
          rerender();
        };
        reader.readAsText(f);
      } else {
        state.attachments.push({ id: uid('a'), kind: 'file', name: f.name, mime: f.type || '', size: f.size, text: '' });
        rerender();
      }
    });
  }
  function readFileAsDataUrl(f, cb) {
    var reader = new FileReader();
    reader.onload = function () { cb(String(reader.result || '')); };
    reader.readAsDataURL(f);
  }
  function autoGrow(ta) {
    ta.style.height = 'auto';
    var lh = parseFloat(window.getComputedStyle(ta).lineHeight) || 22;
    var max = lh * 6;
    ta.style.height = Math.min(max, ta.scrollHeight) + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }
  function updateSendBtn() {
    var btn = document.querySelector('[data-chat-send]');
    if (btn) btn.disabled = !canSend();
  }

  /* ---------- 右键菜单(会话) ---------- */
  document.addEventListener('contextmenu', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var item = target.closest('[data-chat-open]');
    if (!item) return;
    e.preventDefault();
    openCtx(item.getAttribute('data-chat-open'), e.clientX, e.clientY);
  });

  /* ---------- 内容挂载后初始化(懒加载数据) ---------- */
  document.addEventListener('app:afterRender', function (ev) {
    var detail = ev.detail || {};
    if (detail.path !== '/chats') return;
    var ws = currentWorkspaceId();
    if (!state.loaded || state.workspaceId !== ws) {
      state.workspaceId = ws;
      state.selectedId = restoreSelection();
      // 移动端进入:左右侧边栏同时折叠为汉堡抽屉;桌面端左栏保持默认展开
      if (!state.loaded && isMobileLayout()) {
        state.leftOpen = false;
        state.rightOpen = false;
        state.scrim = false;
      }
      load();
    }
  });

  App.defineModule({ id: 'chats', render: render });
})();
