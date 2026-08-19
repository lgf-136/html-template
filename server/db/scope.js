/* ============================================================
 * scope.js — 工作空间隔离规则(纯逻辑,Node / Worker 共用)
 * ------------------------------------------------------------
 * app_settings 表按 workspace_id 分片:
 *   - 全局作用域(workspace_id = 'global')只存放跨工作空间共享的
 *     注册表与当前指针,供前端枚举 / 切换工作空间;
 *   - 其余所有 settings:* 键都归属于某个具体工作空间,切换后
 *     加载不同数据,互相隔离、互不影响。
 * 新增业务数据表时也应带 workspace_id 列并沿用本模块的归属规则。
 * ============================================================ */
'use strict';

/** 全局作用域 id:工作空间注册表与当前指针专用 */
const GLOBAL_WORKSPACE_ID = 'global';

/** 全局键:跨工作空间共享,不随工作空间切换而隔离 */
const GLOBAL_SETTINGS_KEYS = ['settings:workspaces', 'settings:activeWorkspace'];

/** 键是否为全局键(写入 / 读取时落到 global 作用域) */
function isGlobalSettingsKey(key) {
  return GLOBAL_SETTINGS_KEYS.indexOf(key) !== -1 || String(key || '').indexOf('llm:') === 0;
}

/** 依据键名决定归属作用域:全局键 → global;其余 → 指定工作空间(缺省回落 global) */
function workspaceIdForKey(key, activeWorkspace) {
  return isGlobalSettingsKey(key) ? GLOBAL_WORKSPACE_ID : activeWorkspace || GLOBAL_WORKSPACE_ID;
}

module.exports = {
  GLOBAL_WORKSPACE_ID,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
  workspaceIdForKey,
};
