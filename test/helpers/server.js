/* ============================================================
 * test/helpers/server.js — 共享测试启动器
 * ------------------------------------------------------------
 * 每个测试文件独立 spawn 一个真实 dev-server.js 进程,做到模块间完全隔离:
 *   - 随机空闲端口(并发跑也不会端口冲突)
 *   - 临时目录下的 SQLite 数据库(测试结束即删除)
 *   - 固定 ENCRYPTION_KEY(不写 server/.secret-key,不污染仓库)
 *   - 已知 AUTH_PASSWORD,便于登录
 * 提供 fetch 风格的 request / login,以及读取底层 SQLite 原始值的
 * readDbValue,供各模块测试验证「静态资源可访问」「设置读写往返」
 * 「敏感值落库加密而非明文」。
 * ============================================================ */
'use strict';

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_PASSWORD = 'test-password-1234';
// 64 位 hex = 32 字节,与 server/security 的 ENCRYPTION_KEY 约定一致
const TEST_ENCRYPTION_KEY = 'ab'.repeat(32);

/** 向内核申请一个空闲端口后立即释放(竞态窗口极小,测试可接受) */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 / 直到服务器就绪(就绪 = 静态入口返回 200) */
async function waitForHttp(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/');
      if (res.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('dev-server 未能在超时时间内就绪: ' + (lastErr ? lastErr.message : 'timeout'));
}

async function startServer() {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-template-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const baseUrl = 'http://127.0.0.1:' + port;

  const child = spawn(process.execPath, ['dev-server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      AUTH_PASSWORD: TEST_PASSWORD,
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: dbPath,
      LOG_LEVEL: 'error',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  try {
    await waitForHttp(baseUrl, 10000);
  } catch (e) {
    child.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    e.message += '\n--- server stdout ---\n' + stdout + '\n--- server stderr ---\n' + stderr;
    throw e;
  }

  /**
   * HTTP 请求封装。
   * @param {string} method
   * @param {string} pathname
   * @param {{ token?: string, body?: any, headers?: Record<string,string> }} [opts]
   */
  async function request(method, pathname, opts) {
    opts = opts || {};
    const headers = {};
    if (opts.token) headers['x-auth-token'] = opts.token;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.headers) Object.assign(headers, opts.headers);
    const res = await fetch(baseUrl + pathname, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      /* 非 JSON 响应(静态资源) */
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  /** 登录;不传密码时使用测试默认密码,返回 { status, json } */
  function login(password) {
    return request('POST', '/api/auth/login', {
      body: { password: password === undefined ? TEST_PASSWORD : password, expiry: '24h' },
    });
  }

  /** 直接读底层 SQLite 原始值(按 workspace_id 定位,默认 global),
   *  用于断言敏感值落库加密、非明文。 */
  function readDbValue(key, workspaceId) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare('SELECT value FROM app_settings WHERE workspace_id = ? AND key = ?')
        .get(workspaceId || 'global', key);
      return row ? row.value : undefined;
    } finally {
      db.close();
    }
  }

  /** 直接读 apihub_config 表某列(按工作空间定位,默认当前活跃工作空间),
   *  用于断言 Hub 密钥加密落库、数据按工作空间隔离。 */
  function readHubConfig(column, workspaceId) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT ' + column + ' FROM apihub_config WHERE workspace_id = ?').get(workspaceId || 'ws-default');
      return row ? row[column] : undefined;
    } finally {
      db.close();
    }
  }

  /** 直接读 chat_config 表某列(按工作空间定位,默认当前活跃工作空间),
   *  用于断言聊天供应商密钥加密落库、数据按工作空间隔离。 */
  function readChatConfig(column, workspaceId) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT ' + column + ' FROM chat_config WHERE workspace_id = ?').get(workspaceId || 'ws-default');
      return row ? row[column] : undefined;
    } finally {
      db.close();
    }
  }

  /** 停止服务器并清理临时目录 */
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { stdout, stderr };
  }

  return {
    baseUrl,
    port,
    dbPath,
    tmpDir,
    request,
    login,
    readDbValue,
    readHubConfig,
    readChatConfig,
    stop,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

module.exports = { startServer, TEST_PASSWORD, TEST_ENCRYPTION_KEY };
