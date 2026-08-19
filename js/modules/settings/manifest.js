/* ============================================================
 * settings 模块 — 清单
 * ------------------------------------------------------------
 * 从 mpages/apps/web 移植的侧边栏二级子菜单 Settings(仅页面内容,无功能)。
 * 二级菜单 = 模块中的子模块:个人资料 / 账号 / 外观 / 通知 / 显示。
 * 子模块未单独声明 load,统一由父模块 module.js 按路由分发实现。
 * 全部文案在懒加载词典 i18n.js(三语言,与 mpages 源文案一致)。
 * ============================================================ */
App.registerModule({
  id: 'settings',
  title: { 'zh-CN': '设置', 'zh-TW': '設定', en: 'Settings' },
  icon: 'settings',
  css: 'module.css',
  children: [
    {
      id: 'profile',
      title: { 'zh-CN': '个人资料', 'zh-TW': '個人資料', en: 'Profile' },
      route: '/settings',
    },
    {
      id: 'account',
      title: { 'zh-CN': '账户', 'zh-TW': '帳戶', en: 'Account' },
      route: '/settings/account',
    },
    {
      id: 'appearance',
      title: { 'zh-CN': '外观', 'zh-TW': '外觀', en: 'Appearance' },
      route: '/settings/appearance',
    },
    {
      id: 'notifications',
      title: { 'zh-CN': '通知', 'zh-TW': '通知', en: 'Notifications' },
      route: '/settings/notifications',
    },
    {
      id: 'display',
      title: { 'zh-CN': '显示', 'zh-TW': '顯示', en: 'Display' },
      route: '/settings/display',
    },
    {
      id: 'llm',
      title: { 'zh-CN': '大模型', 'zh-TW': '大模型', en: 'LLM Models' },
      route: '/settings/llm',
    },
  ],
  i18nFile: 'i18n.js',
});
