/* ============================================================
 * schema.js — 数据库建表语句(单一事实来源)
 * ------------------------------------------------------------
 * 所有运行时的建表 SQL 都以本文件为准:
 *   - Node(dev-server.js / api/index.js)经 server/db/index.js 引用
 *   - Deno(deno/main.js)经 createRequire 引用
 *   - Cloudflare Worker(worker.js)直接 import(避免重复维护 SCHEMA)
 *
 * app_settings 按 workspace_id 分片(复合主键),工作空间隔离规则见
 * ./scope.js;auth_sessions 是登录会话基础设施,与工作空间无关,保持全局。
 * ============================================================ */
'use strict';

const { GLOBAL_WORKSPACE_ID } = require('./scope');

/** app_settings 单表建表语句(SCHEMA 与迁移共用,避免两处不一致) */
const APP_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS app_settings (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, key)
);`;

/* ---------- API Hub 业务数据表(模块表,均含 workspace_id 列,不混入 app_settings) ---------- */

/** API Hub 配置表:每个工作空间一行,config 明文 / secrets 加密落库 */
const APIHUB_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS apihub_config (
  workspace_id TEXT PRIMARY KEY,
  config       TEXT NOT NULL,
  secrets      TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

/** API Hub 请求运行历史(工作空间隔离,条数上限由 loadHistory 控制) */
const APIHUB_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS apihub_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INTEGER NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apihub_history_ws ON apihub_history (workspace_id, ts);`;

/** API Hub 请求访问日志(工作空间隔离,受条数上限 / 保留天数驱动) */
const APIHUB_LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS apihub_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  ip           TEXT,
  ua           TEXT,
  ms           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apihub_logs_ws ON apihub_logs (workspace_id, ts);`;

/* ---------- 聊天模块业务数据表(工作空间隔离) ---------- */

/** 聊天配置表:每个工作空间一行;config(分组/标签/参数/联网/供应商元数据/提示词/MCP)明文,secrets(供应商 API Key)加密落库 */
const CHAT_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS chat_config (
  workspace_id TEXT PRIMARY KEY,
  config       TEXT NOT NULL,
  secrets      TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

/** 聊天会话表:一行一个会话,消息以 JSON 数组内嵌(messages 列),按工作空间隔离 */
const CHAT_CONVERSATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS chat_conversations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title        TEXT NOT NULL,
  group_id     TEXT NOT NULL DEFAULT '',
  tag_ids      TEXT NOT NULL DEFAULT '[]',
  favorite     INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  provider     TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  prompt_id    TEXT NOT NULL DEFAULT '',
  params       TEXT NOT NULL DEFAULT '{}',
  messages     TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_convs_ws ON chat_conversations (workspace_id, updated_at);`;

const SCHEMA =
  APP_SETTINGS_TABLE +
  `
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,  -- 会话令牌的 SHA-256 哈希,绝不存明文令牌
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  note       TEXT
);` +
  APIHUB_CONFIG_TABLE +
  APIHUB_HISTORY_TABLE +
  APIHUB_LOGS_TABLE +
  CHAT_CONFIG_TABLE +
  CHAT_CONVERSATIONS_TABLE;

/** 旧版 app_settings(key 单主键,无 workspace_id)→ 新版(复合主键)迁移步骤 */
const APP_SETTINGS_MIGRATION_SQL = [
  'ALTER TABLE app_settings RENAME TO app_settings_legacy',
  APP_SETTINGS_TABLE,
  'INSERT INTO app_settings (workspace_id, key, value, updated_at) SELECT ?, key, value, updated_at FROM app_settings_legacy',
  'DROP TABLE app_settings_legacy',
];

/** 列信息中是否已含 workspace_id(旧表无此列) */
function hasWorkspaceColumn(cols) {
  return (cols || []).some(function (c) {
    return c.name === 'workspace_id';
  });
}

/**
 * 异步迁移(供 Turso / D1 / Worker 调用):统一接口 db.query / db.run,
 * 兼容同步驱动(await 对普通数组无副作用)。
 * 旧数据统一迁入 global 作用域(保留不丢失),后续由前端注册表接管归属。
 */
async function migrateAppSettings(db) {
  const cols = await db.query('PRAGMA table_info(app_settings)');
  if (!cols || !cols.length) return; // 表不存在:SCHEMA 已按新结构建表
  if (hasWorkspaceColumn(cols)) return; // 已是新结构
  for (const sql of APP_SETTINGS_MIGRATION_SQL) {
    // 仅 INSERT ... SELECT ? 需要参数;其余 DDL 语句不带占位符
    await db.run(sql, sql.indexOf('?') !== -1 ? [GLOBAL_WORKSPACE_ID] : []);
  }
}

module.exports = {
  SCHEMA,
  APP_SETTINGS_TABLE,
  APIHUB_CONFIG_TABLE,
  APIHUB_HISTORY_TABLE,
  APIHUB_LOGS_TABLE,
  CHAT_CONFIG_TABLE,
  CHAT_CONVERSATIONS_TABLE,
  APP_SETTINGS_MIGRATION_SQL,
  hasWorkspaceColumn,
  migrateAppSettings,
};
