/* ============================================================
 * chat/search.js — 联网搜索供应商(零依赖)
 * ------------------------------------------------------------
 * 作为内置工具注入大模型:web_search(query)。返回统一结构:
 *   { query, results: [{ title, url, snippet }], provider }
 *
 * 内置:
 *   duckduckgo  免费,无需 Key(HTML 端点抓取,零密钥可用)
 *   serper      需 SERPER_API_KEY(providerKeys.search.serper)
 *   tavily      需 TAVILY_API_KEY
 *   bing        需 BING_SEARCH_API_KEY(自定义终结点)
 *   google      需 GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX
 * ============================================================ */
'use strict';

const SEARCH_PROVIDERS = [
  { id: 'duckduckgo', name: 'DuckDuckGo', free: true },
  { id: 'serper', name: 'Serper', free: false },
  { id: 'tavily', name: 'Tavily', free: false },
  { id: 'bing', name: 'Bing Search', free: false },
  { id: 'google', name: 'Google Custom Search', free: false },
];

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/** DuckDuckGo HTML 抓取(无需 Key) */
async function duckduckgo(fetchImpl, query) {
  const url =
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  });
  const html = await res.text();
  const results = [];
  // 每条结果: <a class="result__a" href="...">title</a> + <a class="result__snippet">...</a>
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let sm;
  while ((sm = snipRe.exec(html)) !== null) snippets.push(decodeEntities(sm[1]));
  let m;
  let i = 0;
  while ((m = blockRe.exec(html)) !== null && results.length < 8) {
    const rawUrl = m[1];
    const href = rawUrl.indexOf('uddg=') !== -1 ? decodeURIComponent((rawUrl.match(/uddg=([^&]+)/) || [])[1] || rawUrl) : rawUrl;
    results.push({
      title: decodeEntities(m[2]).trim(),
      url: href,
      snippet: (snippets[i] || '').trim(),
    });
    i++;
  }
  return { query, provider: 'duckduckgo', results };
}

async function jsonProvider(fetchImpl, url, headers, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  return res.json();
}

async function serper(fetchImpl, query, key) {
  const data = await jsonProvider(
    fetchImpl,
    'https://google.serper.dev/search',
    { 'X-API-KEY': key },
    { q: query, gl: 'us', hl: 'en' }
  );
  const organic = data.organic || [];
  return {
    query,
    provider: 'serper',
    results: organic.slice(0, 8).map(function (r) {
      return { title: r.title || '', url: r.link || '', snippet: r.snippet || '' };
    }),
  };
}

async function tavily(fetchImpl, query, key) {
  const data = await jsonProvider(
    fetchImpl,
    'https://api.tavily.com/search',
    { Authorization: 'Bearer ' + key },
    { query, max_results: 8 }
  );
  const results = data.results || [];
  return {
    query,
    provider: 'tavily',
    results: results.slice(0, 8).map(function (r) {
      return { title: r.title || '', url: r.url || '', snippet: r.content || '' };
    }),
  };
}

async function bing(fetchImpl, query, key) {
  const url =
    'https://api.bing.microsoft.com/v7.0/search?q=' +
    encodeURIComponent(query) +
    '&count=8';
  const res = await fetchImpl(url, { headers: { 'Ocp-Apim-Subscription-Key': key } });
  const data = await res.json();
  const web = (data.webPages && data.webPages.value) || [];
  return {
    query,
    provider: 'bing',
    results: web.map(function (r) {
      return { title: r.name || '', url: r.url || '', snippet: r.snippet || '' };
    }),
  };
}

async function google(fetchImpl, query, key, cx) {
  const url =
    'https://www.googleapis.com/customsearch/v1?key=' +
    encodeURIComponent(key) +
    '&cx=' +
    encodeURIComponent(cx) +
    '&q=' +
    encodeURIComponent(query) +
    '&num=8';
  const res = await fetchImpl(url);
  const data = await res.json();
  const items = data.items || [];
  return {
    query,
    provider: 'google',
    results: items.map(function (r) {
      return { title: r.title || '', url: r.link || '', snippet: r.snippet || '' };
    }),
  };
}

/** 执行一次联网搜索。keys 形如 { serper, tavily, bing, google, googleCx }。
 * opts.results 控制返回结果条数(3-15,默认 6)。 */
async function webSearch(deps, provider, query, keys, opts) {
  const fetchImpl = (deps && deps.fetchImpl) || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('搜索需要 fetch 实现');
  const q = String(query || '').slice(0, 500);
  if (!q) return { query: q, provider, results: [] };
  const limit = Math.max(3, Math.min(15, Number((opts && opts.results) || 6)));

  let data;
  if (provider === 'serper') {
    if (!keys.serper) throw new Error('Serper 需要 API Key(在聊天设置 → 搜索 Key 中配置)');
    data = await serper(fetchImpl, q, keys.serper);
  } else if (provider === 'tavily') {
    if (!keys.tavily) throw new Error('Tavily 需要 API Key(在聊天设置 → 搜索 Key 中配置)');
    data = await tavily(fetchImpl, q, keys.tavily);
  } else if (provider === 'bing') {
    if (!keys.bing) throw new Error('Bing 需要 API Key(在聊天设置 → 搜索 Key 中配置)');
    data = await bing(fetchImpl, q, keys.bing);
  } else if (provider === 'google') {
    if (!keys.google || !keys.googleCx)
      throw new Error('Google 需要 API Key 与 Search Engine ID(在聊天设置 → 搜索 Key 中配置)');
    data = await google(fetchImpl, q, keys.google, keys.googleCx);
  } else {
    data = await duckduckgo(fetchImpl, q);
  }
  if (data && Array.isArray(data.results)) data.results = data.results.slice(0, limit);
  return data;
}

module.exports = { SEARCH_PROVIDERS, webSearch };
