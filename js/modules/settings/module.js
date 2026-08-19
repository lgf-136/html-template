/* ============================================================
 * settings 模块 — 实现(懒加载,首次访问 /settings 时下载)
 * ------------------------------------------------------------
 * 从 mpages 移植的 Settings 二级子菜单页面(仅页面内容,无功能):
 * 个人资料 / 账号 / 外观 / 通知 / 显示。
 * 父模块按路由分发到对应页面渲染;表单为静态展示(无提交/校验)。
 * 只依赖核心层 App.ui / App.icon / App.settings / ctx。
 * ============================================================ */
(function () {
  'use strict';

  var S = function () {
    return App.settings;
  };
  var icon = function () {
    return App.icon;
  };

  /* ---------- 页内子导航(与主侧边栏二级菜单一致) ---------- */
  var NAV = [
    { id: 'profile', route: '/settings', icon: 'user-cog', titleKey: 'profile.title' },
    { id: 'account', route: '/settings/account', icon: 'wrench', titleKey: 'account.title' },
    {
      id: 'appearance',
      route: '/settings/appearance',
      icon: 'palette',
      titleKey: 'appearance.title',
    },
    {
      id: 'notifications',
      route: '/settings/notifications',
      icon: 'bell',
      titleKey: 'notifications.title',
    },
    { id: 'display', route: '/settings/display', icon: 'monitor', titleKey: 'display.title' },
    { id: 'llm', route: '/settings/llm', icon: 'bot', titleKey: 'llm.title' },
  ];

  /* ---------- 通用布局 ---------- */
  function contentSection(t, titleKey, descKey, body) {
    return (
      '<div class="sp-section">' +
      '<h3>' +
      t(titleKey) +
      '</h3>' +
      '<p class="sp-section-desc">' +
      t(descKey) +
      '</p>' +
      '<div class="sp-sep"></div>' +
      '<div class="sp-section-body"><div class="sp-section-inner">' +
      body +
      '</div></div>' +
      '</div>'
    );
  }

  /* ---------- 头像选择器(首字母 / 图标 / Emoji / 上传图片;交互由 js/core/avatar.js 处理) ---------- */
  function avatarSection(t, p) {
    var avatar = App.settings.sanitizeAvatar(p.avatar);
    var type = avatar.type;
    var S = App.settings;
    var tabs = S.AVATAR_TYPES.map(function (tp) {
      return (
        '<button type="button" data-avatar-type="' +
        tp +
        '" class="sp-avatar-tab' +
        (type === tp ? ' is-active' : '') +
        '">' +
        t('avatar.type.' + tp) +
        '</button>'
      );
    }).join('');
    var iconGrid = S.AVATAR_ICONS.map(function (name) {
      return (
        '<button type="button" data-avatar-icon="' +
        name +
        '" class="sp-avatar-opt' +
        (type === 'icon' && avatar.value === name ? ' is-active' : '') +
        '" data-tip="' +
        name +
        '">' +
        icon().iconSvg(name) +
        '</button>'
      );
    }).join('');
    var emojiGrid = S.AVATAR_EMOJIS.map(function (em) {
      return (
        '<button type="button" data-avatar-emoji="' +
        em +
        '" class="sp-avatar-opt' +
        (type === 'emoji' && avatar.value === em ? ' is-active' : '') +
        '">' +
        em +
        '</button>'
      );
    }).join('');
    var opt = function (tp, inner) {
      return (
        '<div data-avatar-opt="' +
        tp +
        '"' +
        (type === tp ? '' : ' style="display:none"') +
        '>' +
        inner +
        '</div>'
      );
    };
    return (
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('avatar.title') +
      '</label>' +
      '<div class="sp-avatar-row">' +
      '<span class="shrink-0">' +
      App.ui.avatarHtml(p, 'sp-avatar-lg', true) +
      '</span>' +
      '<div class="sp-avatar-col">' +
      '<div class="sp-avatar-tabs">' +
      tabs +
      '</div>' +
      opt('initial', '<p class="sp-field-desc">' + t('avatar.initialDesc') + '</p>') +
      opt(
        'icon',
        '<p class="sp-field-desc">' +
          t('avatar.iconDesc') +
          '</p>' +
          '<div class="sp-avatar-grid">' +
          iconGrid +
          '</div>'
      ) +
      opt(
        'emoji',
        '<p class="sp-field-desc">' +
          t('avatar.emojiDesc') +
          '</p>' +
          '<div class="sp-avatar-grid">' +
          emojiGrid +
          '</div>'
      ) +
      opt(
        'image',
        '<p class="sp-field-desc">' +
          t('avatar.imageDesc') +
          '</p>' +
          '<div class="sp-avatar-upload">' +
          '<input type="file" data-avatar-file accept="image/*" style="display:none" />' +
          '<button type="button" data-avatar-upload class="' +
          App.ui.buttonClass('outline', 'sm') +
          '">' +
          icon().iconSvg('image-plus', { class: 'size-4' }) +
          t('avatar.upload') +
          '</button>' +
          '</div>' +
          '<p class="sp-avatar-error" data-avatar-error></p>'
      ) +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  /* ---------- 个人资料(数据实时同步数据库 settings:profile,邮箱落库前加密) ---------- */
  function pageProfile(ctx) {
    var t = ctx.t;
    var p = ctx.settings.profile || {};
    var links = Array.isArray(p.links) && p.links.length ? p.links : ['', ''];
    var body =
      '<form class="sp-form">' +
      avatarSection(t, p) +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('profile.username.label') +
      '</label>' +
      '<input class="sp-input" type="text" data-setting="profile.username" value="' +
      escAttr(p.username) +
      '" placeholder="' +
      t('profile.username.placeholder') +
      '" />' +
      '<p class="sp-field-desc">' +
      t('profile.username.description') +
      '</p>' +
      '</div>' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('profile.email.label') +
      '</label>' +
      '<input class="sp-input" type="email" data-setting="profile.email" value="' +
      escAttr(p.email) +
      '" placeholder="' +
      t('profile.email.placeholder') +
      '" />' +
      '<p class="sp-field-desc">' +
      t('profile.email.descriptionBefore') +
      ' <a href="#/settings" data-link="/settings">' +
      t('profile.email.emailSettings') +
      '</a>.</p>' +
      '</div>' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('profile.bio.label') +
      '</label>' +
      '<textarea class="sp-textarea" data-setting="profile.bio" placeholder="' +
      t('profile.bio.placeholder') +
      '">' +
      escHtml(p.bio || '') +
      '</textarea>' +
      '<p class="sp-field-desc">' +
      t('profile.bio.descriptionBefore') +
      ' <span>' +
      t('profile.bio.mention') +
      '</span> ' +
      t('profile.bio.descriptionAfter') +
      '</p>' +
      '</div>' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('profile.urls.label') +
      '</label>' +
      '<p class="sp-field-desc">' +
      t('profile.urls.description') +
      '</p>' +
      '<input class="sp-input" type="url" data-setting="profile.links.0" value="' +
      escAttr(links[0]) +
      '" />' +
      '<input class="sp-input" type="url" data-setting="profile.links.1" value="' +
      escAttr(links[1]) +
      '" />' +
      '<button type="button" class="' +
      App.ui.buttonClass('outline', 'sm') +
      '">' +
      t('profile.urls.add') +
      '</button>' +
      '</div>' +
      '<button type="button" class="' +
      App.ui.buttonClass('default') +
      '">' +
      t('profile.submit') +
      '</button>' +
      '</form>';
    return contentSection(t, 'profile.title', 'profile.description', body);
  }

  function escAttr(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ---------- 账号 ---------- */
  var ACCOUNT_LANGUAGES = [
    { label: 'English', value: 'en' },
    { label: 'French', value: 'fr' },
    { label: 'German', value: 'de' },
    { label: 'Spanish', value: 'es' },
    { label: 'Portuguese', value: 'pt' },
    { label: 'Russian', value: 'ru' },
    { label: 'Japanese', value: 'ja' },
    { label: 'Korean', value: 'ko' },
    { label: 'Chinese', value: 'zh' },
  ];

  /** 自定义下拉(替代原生 <select>,复用 [data-dropdown] 弹层机制,样式类 shadcn Select) */
  function languageSelectHtml(t, value) {
    var selected = null;
    for (var i = 0; i < ACCOUNT_LANGUAGES.length; i++) {
      if (ACCOUNT_LANGUAGES[i].value === value) {
        selected = ACCOUNT_LANGUAGES[i];
        break;
      }
    }
    var options = ACCOUNT_LANGUAGES.map(function (l) {
      var active = l.value === value;
      return (
        '<button type="button" role="option" aria-selected="' +
        active +
        '" data-select-option data-setting="account.language" data-value="' +
        l.value +
        '" class="' +
        App.ui.dropdownItemClass(active ? ' bg-accent text-accent-foreground' : '') +
        '">' +
        '<span class="flex-1 text-left">' +
        l.label +
        '</span>' +
        (active ? icon().iconSvg('check', { class: 'size-4' }) : '') +
        '</button>'
      );
    }).join('');
    return (
      '<div class="relative" data-dropdown>' +
      '<button type="button" data-dropdown-trigger class="sp-select-trigger" aria-haspopup="listbox">' +
      '<span class="sp-select-label">' +
      (selected ? selected.label : t('account.language.selectPlaceholder')) +
      '</span>' +
      '<svg class="sp-select-chevron" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>' +
      '</button>' +
      '<div role="listbox" data-dropdown-menu class="' +
      App.ui.dropdownContentClass('sp-select-menu min-w-48') +
      '">' +
      options +
      '</div>' +
      '</div>'
    );
  }

  /* ---------- 自定义日历(替代原生 input[type=date],样式类 shadcn Calendar) ---------- */
  var calView = null; // { year, month } 当前浏览的年月(0 基)

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isoToDate(iso) {
    if (!iso) return null;
    var d = new Date(String(iso) + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  function monthTitle(year, month, locale) {
    try {
      return new Date(year, month, 1).toLocaleDateString(locale === 'en' ? 'en-US' : locale, {
        year: 'numeric',
        month: 'long',
      });
    } catch (e) {
      return year + '-' + (month + 1);
    }
  }

  function formatDob(iso, locale) {
    var d = isoToDate(iso);
    if (!d) return '';
    try {
      return d.toLocaleDateString(locale === 'en' ? 'en-US' : locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch (e) {
      return iso;
    }
  }

  function calendarInnerHtml(year, month, selected, t, locale) {
    var first = new Date(year, month, 1);
    var startWeekday = first.getDay(); // 0=周日
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var weekdays = String(t('account.dob.weekdays')).split(',');
    var today = todayIso();
    var cells = [];
    for (var w = 0; w < startWeekday; w++) cells.push('<span class="sp-cal-empty"></span>');
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var cls =
        'sp-cal-day' +
        (iso === selected ? ' is-selected' : '') +
        (iso === today ? ' is-today' : '');
      cells.push(
        '<button type="button" data-calendar-day data-value="' +
          iso +
          '" class="' +
          cls +
          '">' +
          d +
          '</button>'
      );
    }
    return (
      '<div class="sp-cal-head">' +
      '<button type="button" data-calendar-prev class="sp-cal-nav" aria-label="Previous month">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>' +
      '</button>' +
      '<div class="sp-cal-title">' +
      monthTitle(year, month, locale) +
      '</div>' +
      '<button type="button" data-calendar-next class="sp-cal-nav" aria-label="Next month">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>' +
      '</button>' +
      '</div>' +
      '<div class="sp-cal-weekdays">' +
      weekdays
        .map(function (w) {
          return '<span>' + w + '</span>';
        })
        .join('') +
      '</div>' +
      '<div class="sp-cal-grid">' +
      cells.join('') +
      '</div>' +
      '<button type="button" data-calendar-clear class="sp-cal-clear">' +
      t('account.dob.clear') +
      '</button>'
    );
  }

  function initCalView(iso) {
    var d = isoToDate(iso) || new Date();
    calView = { year: d.getFullYear(), month: d.getMonth() };
  }

  function rerenderCalendar(t, locale) {
    var root = document.querySelector('[data-cal-root]');
    if (!root || !calView) return;
    var selected = App.getShellContext().settings.account.dob;
    root.innerHTML = calendarInnerHtml(calView.year, calView.month, selected, t, locale);
  }

  /** 自定义日期触发器 + 日历弹层(替代原生 date 输入,复用 [data-dropdown] 机制) */
  function datePickerHtml(t, ac, locale) {
    initCalView(ac.dob);
    var shown = formatDob(ac.dob, locale);
    return (
      '<div class="relative" data-dropdown>' +
      '<button type="button" data-dropdown-trigger class="sp-select-trigger" aria-haspopup="dialog">' +
      '<span class="sp-select-label' +
      (shown ? '' : ' sp-select-placeholder') +
      '">' +
      (shown || t('account.dob.placeholder')) +
      '</span>' +
      '<svg class="sp-select-chevron" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path></svg>' +
      '</button>' +
      '<div data-dropdown-menu class="' +
      App.ui.dropdownContentClass('sp-cal-pop min-w-64') +
      '">' +
      '<div data-cal-root data-year="' +
      calView.year +
      '" data-month="' +
      calView.month +
      '">' +
      calendarInnerHtml(calView.year, calView.month, ac.dob, t, locale) +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function pageAccount(ctx) {
    var t = ctx.t;
    var ac = ctx.settings.account || {};
    var body =
      '<form class="sp-form">' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('account.name.label') +
      '</label>' +
      '<input class="sp-input" type="text" data-setting="account.name" value="' +
      escAttr(ac.name) +
      '" placeholder="' +
      t('account.name.placeholder') +
      '" />' +
      '<p class="sp-field-desc">' +
      t('account.name.description') +
      '</p>' +
      '</div>' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('account.dob.label') +
      '</label>' +
      datePickerHtml(t, ac, ctx.settings.locale) +
      '<p class="sp-field-desc">' +
      t('account.dob.description') +
      '</p>' +
      '</div>' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('account.language.label') +
      '</label>' +
      languageSelectHtml(t, ac.language) +
      '<p class="sp-field-desc">' +
      t('account.language.description') +
      '</p>' +
      '</div>' +
      '<button type="button" class="' +
      App.ui.buttonClass('default') +
      '">' +
      t('account.submit') +
      '</button>' +
      '</form>';
    return contentSection(t, 'account.title', 'account.description', body);
  }

  /* ---------- 外观(mpages radio-group 风格):卡片统一用 App.ui.radio(样式 app.css .rg-*) ---------- */
  function optSection(t, titleKey, inner) {
    return '<div class="sp-opt-group">' + App.ui.radio.sectionTitle(t(titleKey)) + inner + '</div>';
  }

  function pageAppearance(ctx) {
    var t = ctx.t;
    var s = ctx.settings;
    var ap = s.appearance;
    var st = S();
    var radio = App.ui.radio;

    var layout =
      s.sidebarVariant === 'inset'
        ? 'default'
        : s.sidebarCollapsible === 'offcanvas'
          ? 'offcanvas'
          : 'icon';
    var themeItems = st.THEME_ITEMS;
    var sidebarItems = st.SIDEBAR_ITEMS;
    var layoutItems = st.LAYOUT_ITEMS;

    var body =
      '<div class="sp-form">' +
      optSection(
        t,
        'settings.theme',
        '<div class="' +
          radio.gridClass(3) +
          '">' +
          themeItems
            .map(function (it) {
              return radio.iconCard(
                it.icon,
                t(it.labelKey),
                s.theme === it.value,
                true,
                'theme:' + it.value
              );
            })
            .join('') +
          '</div>'
      ) +
      optSection(
        t,
        'settings.sidebar',
        '<div class="' +
          radio.gridClass(3) +
          '">' +
          sidebarItems
            .map(function (it) {
              return radio.iconCard(
                it.icon,
                t(it.labelKey),
                s.sidebarVariant === it.value,
                false,
                'sidebar:' + it.value
              );
            })
            .join('') +
          '</div>'
      ) +
      optSection(
        t,
        'settings.layout',
        '<div class="' +
          radio.gridClass(3) +
          '">' +
          layoutItems
            .map(function (it) {
              return radio.iconCard(
                it.icon,
                t(it.labelKey),
                layout === it.value,
                false,
                'layout:' + it.value
              );
            })
            .join('') +
          '</div>'
      ) +
      optSection(
        t,
        'settings.baseColor',
        radio.swatchPicker(ap.baseColor, st.BASE_COLORS, 7, 'base')
      ) +
      optSection(
        t,
        'settings.chartColor',
        radio.swatchPicker(ap.chartColor, [ap.baseColor].concat(st.CHART_COLORS), 6, 'chart')
      ) +
      optSection(
        t,
        'settings.style',
        radio.segmented(
          st.STYLES.map(function (v) {
            return { value: v, label: v };
          }),
          ap.style,
          4,
          'style'
        )
      ) +
      optSection(
        t,
        'settings.bodyFont',
        radio.segmented(
          st.FONTS.map(function (f) {
            return { value: f.value, label: f.label };
          }),
          ap.bodyFont,
          3,
          'body-font'
        )
      ) +
      optSection(
        t,
        'settings.headingFont',
        radio.segmented(
          st.FONTS.map(function (f) {
            return { value: f.value, label: f.label };
          }),
          ap.headingFont,
          3,
          'heading-font'
        )
      ) +
      radio.readonlyRow(t('settings.iconLibrary'), t('settings.lucide')) +
      optSection(
        t,
        'settings.radius',
        radio.segmented(
          st.RADII.map(function (r) {
            return { value: r.value, label: t(r.labelKey) };
          }),
          ap.radius,
          3,
          'radius'
        )
      ) +
      optSection(
        t,
        'settings.menuColor',
        radio.segmented(
          [
            { value: 'default', label: t('settings.menuColorOptions.default') },
            { value: 'inverted', label: t('settings.menuColorOptions.inverted') },
          ],
          ap.menuColor,
          2,
          'menu-color'
        )
      ) +
      optSection(
        t,
        'settings.menuAppearance',
        radio.segmented(
          [
            { value: 'solid', label: t('settings.menuAppearanceOptions.solid') },
            { value: 'translucent', label: t('settings.menuAppearanceOptions.translucent') },
          ],
          ap.menuAppearance,
          2,
          'menu-appearance'
        )
      ) +
      radio.readonlyRow(t('settings.menuAccent'), t('settings.subtle')) +
      '<button type="button" data-reset-appearance class="' +
      App.ui.buttonClass('destructive') +
      '">' +
      t('appearance.reset') +
      '</button>' +
      '</div>';
    return contentSection(t, 'appearance.title', 'appearance.description', body);
  }

  /* ---------- 通知(数据实时同步数据库 settings:notifications) ---------- */
  /** 胶囊开关:视觉 span + 真实 checkbox(label 包裹点击切换,change 事件委托更新) */
  function switchRow(t, labelKey, descKey, on, disabled, setting) {
    return (
      '<label class="sp-switch-row">' +
      '<div class="sp-switch-info">' +
      '<span class="sp-label">' +
      t(labelKey) +
      '</span>' +
      '<p class="sp-field-desc">' +
      t(descKey) +
      '</p>' +
      '</div>' +
      '<span role="switch" aria-checked="' +
      on +
      '" class="sp-switch' +
      (on ? ' is-on' : '') +
      (disabled ? ' is-disabled' : '') +
      '"></span>' +
      '<input type="checkbox" class="sp-switch-input" data-setting="' +
      setting +
      '"' +
      (on ? ' checked' : '') +
      (disabled ? ' disabled' : '') +
      ' />' +
      '</label>'
    );
  }

  function pageNotifications(ctx) {
    var t = ctx.t;
    var n = ctx.settings.notifications || {};
    // 自定义单选框(替代原生 radio):真实 input 隐藏,视觉用 .sp-radio-dot,
    // label 包裹点击即切换,change 事件委托仍由核心层处理(样式类 shadcn RadioGroup)。
    var radioItem = function (value, labelKey) {
      return (
        '<label class="sp-radio">' +
        '<input type="radio" class="sp-radio-input" name="notify-type" data-setting="notifications.type" value="' +
        value +
        '"' +
        (n.type === value ? ' checked' : '') +
        ' />' +
        '<span class="sp-radio-dot" aria-hidden="true"></span>' +
        '<span class="sp-label">' +
        t(labelKey) +
        '</span>' +
        '</label>'
      );
    };
    var body =
      '<form class="sp-form">' +
      '<div class="sp-field">' +
      '<label class="sp-label">' +
      t('notifications.notifyLabel') +
      '</label>' +
      radioItem('all', 'notifications.type.all') +
      radioItem('mentions', 'notifications.type.mentions') +
      radioItem('none', 'notifications.type.none') +
      '</div>' +
      '<div>' +
      '<h3 class="mb-4 text-lg font-medium" style="font-family:var(--font-heading-base,inherit)">' +
      t('notifications.emailSection') +
      '</h3>' +
      '<div style="display:flex;flex-direction:column;gap:1rem">' +
      switchRow(
        t,
        'notifications.communication.label',
        'notifications.communication.description',
        !!n.communication,
        false,
        'notifications.communication'
      ) +
      switchRow(
        t,
        'notifications.marketing.label',
        'notifications.marketing.description',
        !!n.marketing,
        false,
        'notifications.marketing'
      ) +
      switchRow(
        t,
        'notifications.social.label',
        'notifications.social.description',
        !!n.social,
        false,
        'notifications.social'
      ) +
      switchRow(
        t,
        'notifications.security.label',
        'notifications.security.description',
        true,
        true,
        'notifications.security'
      ) +
      '</div></div>' +
      // 自定义复选框(替代原生 checkbox):样式复用显示页 .sp-checkbox,
      // 真实 input 隐藏,label 包裹点击切换,change 事件委托由核心层处理。
      '<label class="sp-checkbox-row">' +
      '<input type="checkbox" class="sp-checkbox-input" data-setting="notifications.mobile"' +
      (n.mobile ? ' checked' : '') +
      ' />' +
      '<span class="sp-checkbox">' +
      icon().iconSvg('check', { class: 'size-3' }) +
      '</span>' +
      '<div class="sp-switch-info" style="gap:0.25rem">' +
      '<span class="sp-label" style="line-height:1.5">' +
      t('notifications.mobile.label') +
      '</span>' +
      '<p class="sp-field-desc">' +
      t('notifications.mobile.descriptionBefore') +
      ' <a href="#/settings" data-link="/settings">' +
      t('notifications.mobile.mobileSettings') +
      '</a> ' +
      t('notifications.mobile.descriptionAfter') +
      '</p>' +
      '</div></label>' +
      '<button type="button" class="' +
      App.ui.buttonClass('default') +
      '">' +
      t('notifications.submit') +
      '</button>' +
      '</form>';
    return contentSection(t, 'notifications.title', 'notifications.description', body);
  }

  /* ---------- 显示(侧边栏显示控制:勾选实时控制侧边栏可见性,设置项锁定) ---------- */
  /** 单行渲染(父级 data-nav-toggle=id,子级 data-nav-toggle=parent:child,均可独立显隐) */
  function displayRow(t, navId, label, ic, checked, locked, sub) {
    return (
      '<button type="button" data-nav-toggle="' +
      navId +
      '" class="sp-display-item' +
      (sub ? ' is-sub' : '') +
      (locked ? ' is-locked' : '') +
      (checked ? '' : ' is-hidden') +
      '">' +
      '<span class="sp-checkbox' +
      (checked ? ' is-checked' : '') +
      '">' +
      (checked ? icon().iconSvg('check', { class: 'size-3' }) : '') +
      '</span>' +
      '<span class="sp-item-icon">' +
      icon().iconSvg(ic) +
      '</span>' +
      '<span class="sp-item-title">' +
      label +
      '</span>' +
      (locked
        ? '<span class="sp-lock">' + icon().iconSvg('lock') + t('display.locked') + '</span>'
        : '') +
      '</button>'
    );
  }

  function pageDisplay(ctx) {
    var t = ctx.t;
    var hidden = ctx.settings.hiddenNav || [];
    // 用不过滤的完整列表(含全部二级菜单),隐藏项也要能在此重新显示;
    // 列表来自模块注册表(App.buildAllNavItems),新增模块/子模块自动出现,无需硬编码。
    var items = App.buildAllNavItems(ctx.settings.locale);
    var rows = [];
    items.forEach(function (item) {
      var locked = item.id === 'settings';
      rows.push(
        displayRow(t, item.id, item.title, item.icon, hidden.indexOf(item.id) === -1, locked, false)
      );
      (item.children || []).forEach(function (c) {
        var navId = item.id + ':' + c.id;
        rows.push(
          displayRow(t, navId, c.title, 'chevron-right', hidden.indexOf(navId) === -1, false, true)
        );
      });
    });
    var body =
      '<div class="sp-display-group">' +
      '<h4>' +
      t('display.sidebar.label') +
      '</h4>' +
      '<div class="sp-display-items">' +
      rows.join('') +
      '</div>' +
      '</div>' +
      '<p class="sp-display-hint">' +
      t('display.lockHint') +
      '</p>' +
      '<p class="sp-display-hint">' +
      t('display.submenuHint') +
      '</p>';
    return contentSection(t, 'display.title', 'display.description', body);
  }

  /* ---------- 大模型全局设置(供应商 / MCP / 默认参数 / API Key → app_settings llm:*) ---------- */
  var LLM_BUILTIN = [
    { id: 'opencode-go', name: 'OpenCode Go' },
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Claude (Anthropic)' },
    { id: 'gemini', name: 'Gemini (Google)' },
    { id: 'grok', name: 'Grok (xAI)' },
    { id: 'groq', name: 'Groq' },
    { id: 'huggingface', name: 'Hugging Face' },
    { id: 'cerebras', name: 'Cerebras' },
    { id: 'openrouter', name: 'OpenRouter' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'kimi', name: 'Kimi (Moonshot)' },
    { id: 'glm', name: 'GLM (智谱)' },
    { id: 'qwen', name: 'Qwen (通义千问)' },
    { id: 'siliconflow', name: '硅基流动 (SiliconFlow)' },
    { id: 'mistral', name: 'Mistral' },
    { id: 'perplexity', name: 'Perplexity' },
    { id: 'cohere', name: 'Cohere' },
    { id: 'together', name: 'Together AI' },
    { id: 'fireworks', name: 'Fireworks AI' },
    { id: 'ollama', name: 'Ollama (本地)' },
    { id: 'lmstudio', name: 'LM Studio (本地)' },
  ];

  var LLM = {
    providers: [], // 自定义供应商
    mcp: [],
    defaults: {},
    keys: {}, // providerId -> API Key
    catalog: [], // 内置供应商目录(/api/chat/providers)
    overrides: {}, // llm:overrides — providerId -> { temperature, topP, maxTokens }
    search: {}, // llm:search — { provider, results }
    providerModels: {}, // llm:providerModels — providerId -> 该供应商默认模型
    models: {}, // llm:models — providerId -> 拉取到的模型列表
    loaded: false,
    error: null,
    form: null, // { kind: 'provider'|'mcp', id } 内联表单
    fetching: {}, // providerId -> bool(模型列表拉取中)
    busy: {}, // providerId/mcpId -> bool(余额 / 工具拉取中)
  };

  function escLlm(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function llmParseArr(s) {
    try {
      var v = JSON.parse(s || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  function llmParseObj(s) {
    try {
      var v = JSON.parse(s || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      return {};
    }
  }
  function llmAllProviders() {
    var list = LLM_BUILTIN.map(function (b) {
      var cat = null;
      for (var i = 0; i < LLM.catalog.length; i++) if (LLM.catalog[i].id === b.id) cat = LLM.catalog[i];
      return {
        id: b.id,
        name: b.name,
        builtin: true,
        baseUrl: (cat && cat.baseUrl) || '',
        kind: (cat && cat.kind) || 'openai',
        keyUrl: (cat && cat.keyUrl) || '',
        note: (cat && cat.note) || '',
        multimodal: !!(cat && cat.multimodal),
      };
    });
    (LLM.providers || []).forEach(function (p) {
      list.push({
        id: p.id,
        name: p.name,
        builtin: false,
        baseUrl: p.baseUrl,
        kind: p.kind,
        keyUrl: '',
        note: p.note || '',
        multimodal: !!p.multimodal,
      });
    });
    return list;
  }
  function llmProviderName(id) {
    for (var i = 0; i < LLM_BUILTIN.length; i++) if (LLM_BUILTIN[i].id === id) return LLM_BUILTIN[i].name;
    for (var j = 0; j < (LLM.providers || []).length; j++) if (LLM.providers[j].id === id) return LLM.providers[j].name;
    return id || '';
  }

  function pageLlm(ctx) {
    var t = ctx.t;
    var loading = LLM.loaded && !LLM.error ? '' : '<p class="sp-field-desc">加载中…</p>';
    return contentSection(t, 'llm.title', 'llm.description', '<div data-llm-page class="sp-llm">' + loading + '</div>');
  }

  function renderLlmPage() {
    var el = document.querySelector('[data-llm-page]');
    if (!el) return;
    var t = moduleT();
    if (LLM.error) {
      el.innerHTML = '<p class="sp-field-desc" style="color:var(--destructive)">' + escLlm(LLM.error) + '</p>';
      return;
    }
    el.innerHTML =
      llmIntroHtml(t) +
      llmSection(t, 'llm.defaults', 'llm.defaults.desc', llmDefaultsHtml(t)) +
      llmSection(t, 'llm.providers', 'llm.providers.desc', llmProvidersHtml(t)) +
      llmSection(t, 'llm.mcp', 'llm.mcp.desc', llmMcpHtml(t)) +
      llmSection(t, 'llm.search', 'llm.search.desc', llmSearchHtml(t));
  }

  function llmIntroHtml(t) {
    return (
      '<div class="sp-llm-intro">' +
      '<p>' + t('llm.intro1') + '</p>' +
      '<p>' + t('llm.intro2') + '</p>' +
      '<p class="sp-llm-tip">' + t('llm.introTip') + '</p>' +
      '</div>'
    );
  }

  function llmSection(t, titleKey, descKey, body) {
    return (
      '<div class="sp-section"><h3>' + t(titleKey) + '</h3><p class="sp-section-desc">' + t(descKey) +
      '</p><div class="sp-sep"></div><div class="sp-section-body"><div class="sp-section-inner">' + body +
      '</div></div></div>'
    );
  }

  /* ---------- 通用参数(全局默认,模块级可覆盖) ---------- */
  function llmDefaultsHtml(t) {
    var d = LLM.defaults || {};
    var params = d.params || {};
    var provider = d.provider || 'opencode-go';
    var model = d.model || '';
    var thinking = d.thinking || 'none';
    var prompt = d.prompt || '';
    var temp = params.temperature != null ? params.temperature : 0.7;
    var topP = params.topP != null ? params.topP : 1;
    var maxTokens = params.maxTokens != null ? params.maxTokens : 8192;

    var maxPresets = [
      [2048, '2K (2,048)'], [4096, '4K (4,096)'], [8192, '8K (8,192)'],
      [16384, '16K (16,384)'], [32768, '32K (32,768)'], [65536, '64K (65,536)'],
      [131072, '128K (131,072)'], [262144, '256K (262,144)'], [393216, '384K (393,216)'],
    ];
    var fetched = LLM.models[provider] || [];
    var modelOpts = fetched.map(function (m) {
      return llmOptItem('model:' + m, m, m === model);
    }).join('');

    function field(labelKey, inner, desc) {
      return (
        '<div class="sp-field"><label class="sp-label">' + t(labelKey) + '</label>' + inner +
        (desc ? '<p class="sp-field-desc">' + desc + '</p>' : '') + '</div>'
      );
    }
    return (
      '<div class="sp-llm-grid">' +
      field('llm.provider',
        llmSelectHtml(llmProviderName(provider),
          llmAllProviders().map(function (p) { return llmOptItem('provider:' + p.id, p.name, p.id === provider); }).join(''))) +
      field('llm.model',
        '<div class="sp-llm-modelrow">' +
        '<input class="sp-input" data-llm-field="model" value="' + escLlm(model) + '" placeholder="' + t('llm.model') + '">' +
        '<button type="button" data-llm-fetch-models="' + escLlm(provider) + '" class="sp-llm-btn"' + (LLM.fetching[provider] ? ' disabled' : '') + '>' +
        (LLM.fetching[provider] ? t('llm.fetching') : t('llm.fetchModels')) + '</button>' +
        '</div>' +
        (fetched.length ? '<div class="sp-llm-modelrow" style="margin-top:0.375rem">' + llmSelectHtml(t('llm.chooseModel'), modelOpts) + '</div>' : '')) +
      field('llm.temperature',
        spSliderHtml('temperature', 0, 2, 0.05, temp),
        '0(严谨) — 2(创意)') +
      field('llm.topP',
        spSliderHtml('topP', 0, 1, 0.01, topP),
        '0(聚焦) — 1(全采样)') +
      field('llm.maxTokens',
        '<div class="sp-llm-modelrow">' +
        '<input class="sp-input" data-llm-field="maxTokens" value="' + escLlm(llmFormatTokens(maxTokens)) + '" placeholder="如 8k / 0.5M">' +
        llmSelectHtml(llmFormatTokens(maxTokens),
          maxPresets.map(function (m) { return llmOptItem('maxtokens:' + m[0], m[1], Number(maxTokens) === m[0]); }).join('')) +
        '</div>' +
        '<p class="sp-field-desc">' + t('llm.maxTokensHint') + '</p>') +
      field('llm.thinking',
        llmSelectHtml(thinking,
          ['none', 'low', 'medium', 'high', 'max'].map(function (v) { return llmOptItem('thinking:' + v, v, v === thinking); }).join(''))) +
      field('llm.systemPrompt',
        '<textarea class="sp-textarea" data-llm-field="prompt" rows="4" placeholder="' + t('llm.systemPromptPh') + '">' + escLlm(prompt) + '</textarea>',
        t('llm.systemPromptHint')) +
      '</div>' +
      '<div class="sp-llm-savebar"><button type="button" data-llm-save-defaults class="sp-llm-btn is-primary">' + t('llm.save') + '</button>' +
      '<span class="sp-field-desc">' + t('llm.savedDesc') + '</span></div>'
    );
  }

  function llmFormatTokens(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '';
    if (n % 1000000 === 0) return (n / 1000000) + 'M';
    if (n % 1000 === 0) return (n / 1000) + 'K';
    if (n > 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  /* ---------- 自研滑块(替代原生 range) ---------- */
  var llmSlider = null;
  function spSliderHtml(param, min, max, step, value) {
    var pct = Math.round(((value - min) / (max - min)) * 100);
    return (
      '<div class="sp-slider-row">' +
      '<div class="sp-slider" data-sp-slider="' + param + '" data-min="' + min + '" data-max="' + max + '" data-step="' + step + '" data-value="' + value + '">' +
      '<div class="sp-slider-track"><div class="sp-slider-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="sp-slider-thumb" style="left:' + pct + '%"></div>' +
      '</div>' +
      '<span class="sp-slider-val" data-sp-slider-val="' + param + '">' + Number(value).toFixed(2) + '</span>' +
      '</div>'
    );
  }
  function spSliderFromEvent(sl, e) {
    var d = llmSlider;
    if (!d) return;
    var track = sl.querySelector('.sp-slider-track');
    if (!track) return;
    var rect = track.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var val = d.min + ratio * (d.max - d.min);
    val = Math.max(d.min, Math.min(d.max, Math.round(val / d.step) * d.step));
    sl.setAttribute('data-value', val);
    var pct = ((val - d.min) / (d.max - d.min)) * 100;
    var fill = sl.querySelector('.sp-slider-fill');
    var thumb = sl.querySelector('.sp-slider-thumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
    var num = document.querySelector('[data-sp-slider-val="' + d.param + '"]');
    if (num) num.textContent = Number(val).toFixed(2);
    if (!LLM.defaults.params) LLM.defaults.params = {};
    LLM.defaults.params[d.param] = val;
  }

  /* ---------- 下拉(替代原生 select,复用 [data-dropdown] 弹层机制) ---------- */
  function llmSelectHtml(label, menuHtml) {
    return (
      '<div class="relative" data-dropdown>' +
      '<button type="button" data-dropdown-trigger class="sp-select-trigger" aria-haspopup="listbox">' +
      '<span class="sp-select-label">' + escLlm(label) + '</span>' +
      '<svg class="sp-select-chevron" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>' +
      '</button>' +
      '<div role="listbox" data-dropdown-menu class="' + App.ui.dropdownContentClass('sp-select-menu min-w-44') + '">' + menuHtml + '</div>' +
      '</div>'
    );
  }
  function llmOptItem(attrValue, label, active) {
    return (
      '<button type="button" role="option" data-llm-opt="' + escLlm(attrValue) + '" class="' +
      App.ui.dropdownItemClass(active ? ' bg-accent text-accent-foreground' : '') + '">' +
      '<span class="flex-1 text-left">' + escLlm(label) + '</span>' + (active ? icon().iconSvg('check', { class: 'size-4' }) : '') + '</button>'
    );
  }

  /* ---------- 供应商配置(内置 + 自定义卡片) ---------- */
  function llmProvidersHtml(t) {
    var all = llmAllProviders();
    var defProvider = (LLM.defaults && LLM.defaults.provider) || '';
    var cards = all.map(function (p) {
      return llmProviderCardHtml(t, p, p.id === defProvider);
    }).join('');
    var form = '';
    if (LLM.form && LLM.form.kind === 'provider') {
      var editing = (LLM.providers || []).filter(function (x) { return x.id === LLM.form.id; })[0] || {};
      form = llmProviderFormHtml(t, editing);
    }
    return (
      '<div class="sp-llm-head">' +
      '<h4>' + t('llm.providerCount') + ' (' + all.length + ')</h4>' +
      (form ? '' : '<button type="button" data-llm-add-provider class="sp-llm-btn is-primary">' + t('llm.addProvider') + '</button>') +
      '</div>' +
      '<div class="sp-llm-cards">' + cards + '</div>' +
      form
    );
  }

  function llmProviderCardHtml(t, p, isDefault) {
    var key = LLM.keys[p.id] || '';
    var keySet = !!key;
    var model = LLM.providerModels[p.id] || '';
    var fetched = LLM.models[p.id] || [];
    var ov = LLM.overrides[p.id] || {};
    var fetching = LLM.fetching[p.id];
    var busy = LLM.busy[p.id];
    var modelOpts = fetched.map(function (m) { return llmOptItem('pmodel:' + p.id + ':' + m, m, m === model); }).join('');
    var ovTemp = [['', t('llm.useGlobal')], ['0', '0'], ['0.5', '0.5'], ['0.7', '0.7'], ['1', '1'], ['1.5', '1.5'], ['2', '2']];
    var ovTopP = [['', t('llm.useGlobal')], ['0', '0'], ['0.3', '0.3'], ['0.5', '0.5'], ['0.7', '0.7'], ['1', '1']];
    var ovMax = [['', t('llm.useGlobal')], ['2048', '2K'], ['4096', '4K'], ['8192', '8K'], ['16384', '16K'], ['32768', '32K'], ['65536', '64K'], ['131072', '128K'], ['262144', '256K'], ['393216', '384K']];
    function overSelect(pid, param, opts, current) {
      var label = current != null && current !== '' ? opts.filter(function (o) { return o[0] === String(current); })[0] : null;
      return llmSelectHtml(label ? label[1] : t('llm.useGlobal'),
        opts.map(function (o) {
          return llmOptItem('override:' + pid + ':' + param + ':' + o[0], o[1], o[0] === String(current));
        }).join(''));
    }
    return (
      '<div class="sp-llm-card' + (isDefault ? ' is-default' : '') + '">' +
      '<div class="sp-llm-card-head">' +
      '<span class="sp-llm-card-name">' + escLlm(p.name) + '</span>' +
      (p.builtin
        ? '<span class="sp-llm-badge">' + t('llm.builtin') + '</span>'
        : '<span class="sp-llm-badge is-custom">' + t('llm.custom') + '</span>') +
      (isDefault ? '<span class="sp-llm-badge is-active">' + t('llm.active') + '</span>' : '') +
      (p.multimodal ? '<span class="sp-llm-badge is-mm">' + t('llm.multimodal') + '</span>' : '') +
      (!p.builtin
        ? '<span class="sp-llm-card-x">' +
          '<button type="button" class="sp-llm-btn is-ghost" data-llm-edit-provider="' + escLlm(p.id) + '">' + t('llm.edit') + '</button>' +
          '<button type="button" class="sp-llm-btn is-danger is-ghost" data-llm-del-provider="' + escLlm(p.id) + '">' + t('llm.delete') + '</button>' +
          '</span>'
        : '') +
      '</div>' +
      '<div class="sp-llm-card-body">' +
      '<div class="sp-llm-card-row">' +
      '<span class="sp-llm-card-label">' + t('llm.apiKey') + '</span>' +
      '<input type="password" class="sp-input is-mono" data-llm-key="' + escLlm(p.id) + '" placeholder="sk-…" autocomplete="off" value="' + escLlm(key) + '">' +
      '<span class="sp-llm-key-state' + (keySet ? ' is-set' : '') + '">' + (keySet ? t('llm.keySet') : t('llm.keyMissing')) + '</span>' +
      (p.keyUrl ? '<a class="sp-llm-link" href="' + escLlm(p.keyUrl) + '" target="_blank" rel="noreferrer">' + t('llm.getKey') + '</a>' : '') +
      '</div>' +
      '<div class="sp-llm-card-row">' +
      '<span class="sp-llm-card-label">Base URL</span>' +
      '<code class="sp-llm-url">' + escLlm(p.baseUrl || t('llm.noBaseUrl')) + '</code>' +
      '</div>' +
      '<div class="sp-llm-card-row">' +
      '<span class="sp-llm-card-label">' + t('llm.defaultModel') + '</span>' +
      '<input class="sp-input is-mono" data-llm-pmodel="' + escLlm(p.id) + '" value="' + escLlm(model) + '" placeholder="' + t('llm.model') + '">' +
      '<button type="button" data-llm-fetch-models="' + escLlm(p.id) + '" class="sp-llm-btn"' + (fetching ? ' disabled' : '') + '>' +
      (fetching ? t('llm.fetching') : t('llm.fetchModels')) + '</button>' +
      (modelOpts ? '<div style="min-width:9rem">' + llmSelectHtml(model || t('llm.chooseModel'), modelOpts) + '</div>' : '') +
      '</div>' +
      '<div class="sp-llm-card-over">' +
      '<span class="sp-llm-card-label">' + t('llm.overrides') + '</span>' +
      '<div class="sp-llm-over-row">' +
      overSelect(p.id, 'temperature', ovTemp, ov.temperature) +
      overSelect(p.id, 'topP', ovTopP, ov.topP) +
      overSelect(p.id, 'maxTokens', ovMax, ov.maxTokens) +
      '</div>' +
      '</div>' +
      '<div class="sp-llm-card-foot">' +
      '<button type="button" class="sp-llm-btn" data-llm-balance="' + escLlm(p.id) + '"' + (busy ? ' disabled' : '') + '>' +
      (busy ? t('llm.querying') : t('llm.balance')) + '</button>' +
      (p.note ? '<span class="sp-field-desc">' + escLlm(p.note) + '</span>' : '') +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function llmProviderFormHtml(t, p) {
    var kind = p.kind || 'openai';
    return (
      '<div class="sp-llm-form">' +
      '<input class="sp-input" data-llm-f-name placeholder="' + t('llm.name') + '" value="' + escLlm(p.name) + '">' +
      '<input class="sp-input" data-llm-f-base placeholder="' + t('llm.baseUrl') + ' (https://api.example.com/v1)" value="' + escLlm(p.baseUrl) + '">' +
      '<input class="sp-input" data-llm-f-kind placeholder="' + t('llm.kind') + ' (openai / anthropic)" value="' + escLlm(kind) + '">' +
      '<input class="sp-input" data-llm-f-models placeholder="' + t('llm.models') + '" value="' + escLlm((p.models || []).join(',')) + '">' +
      '<div class="sp-llm-form-actions">' +
      '<button type="button" data-llm-save-provider class="sp-llm-btn is-primary">' + t('llm.save') + '</button>' +
      '<button type="button" data-llm-cancel-form class="sp-llm-btn">' + t('llm.cancel') + '</button>' +
      '</div></div>'
    );
  }

  /* ---------- MCP 服务器(https / sse,工具列表可拉取) ---------- */
  function llmMcpHtml(t) {
    var rows = (LLM.mcp || []).map(function (s) {
      var tools = s.tools || [];
      var busy = LLM.busy[s.id];
      return (
        '<div class="sp-llm-card">' +
        '<div class="sp-llm-card-head">' +
        '<span class="sp-llm-badge is-proto">' + escLlm(s.protocol || 'https') + '</span>' +
        '<span class="sp-llm-card-name">' + escLlm(s.name || s.id) + '</span>' +
        (tools.length ? '<span class="sp-llm-badge">' + tools.length + ' ' + t('llm.tools') + '</span>' : '') +
        '<span class="sp-llm-card-x">' +
        '<span role="switch" aria-checked="' + (!!s.enabled) + '" class="sp-switch' + (s.enabled ? ' is-on' : '') + '" data-llm-mcp-toggle="' + escLlm(s.id) + '"></span>' +
        '<button type="button" class="sp-llm-btn" data-llm-mcp-tools="' + escLlm(s.id) + '"' + (busy ? ' disabled' : '') + '>' +
        (busy ? t('llm.fetching') : t('llm.fetchTools')) + '</button>' +
        '<button type="button" class="sp-llm-btn is-ghost" data-llm-edit-mcp="' + escLlm(s.id) + '">' + t('llm.edit') + '</button>' +
        '<button type="button" class="sp-llm-btn is-danger is-ghost" data-llm-del-mcp="' + escLlm(s.id) + '">' + t('llm.delete') + '</button>' +
        '</span>' +
        '</div>' +
        '<div class="sp-llm-card-body">' +
        '<div class="sp-llm-card-row"><span class="sp-llm-card-label">URL</span><code class="sp-llm-url">' + escLlm(s.url) + '</code></div>' +
        (tools.length
          ? '<div class="sp-llm-tools">' + tools.slice(0, 6).map(function (tt) { return '<span class="sp-llm-tool-chip">' + escLlm(tt.name) + '</span>'; }).join('') +
            (tools.length > 6 ? '<span class="sp-field-desc">+ ' + (tools.length - 6) + '</span>' : '') + '</div>'
          : '') +
        '</div>' +
        '</div>'
      );
    }).join('');
    if (!rows) rows = '<p class="sp-field-desc">' + t('llm.mcp.desc') + '</p>';
    var form = '';
    if (LLM.form && LLM.form.kind === 'mcp') {
      var editing = (LLM.mcp || []).filter(function (x) { return x.id === LLM.form.id; })[0] || {};
      form = llmMcpFormHtml(t, editing);
    }
    return (
      '<div class="sp-llm-list">' + rows + '</div>' +
      (form || '<button type="button" data-llm-add-mcp class="sp-llm-btn is-primary">' + t('llm.addMcp') + '</button>')
    );
  }

  function llmMcpFormHtml(t, s) {
    var protocol = s.protocol || 'https';
    return (
      '<div class="sp-llm-form">' +
      '<input class="sp-input" data-llm-f-name placeholder="' + t('llm.name') + '" value="' + escLlm(s.name) + '">' +
      '<input class="sp-input" data-llm-f-url placeholder="' + t('llm.url') + ' (https://…或 sse://…)" value="' + escLlm(s.url) + '">' +
      '<input class="sp-input" data-llm-f-protocol placeholder="' + t('llm.protocol') + ' (https / sse)" value="' + escLlm(protocol) + '">' +
      '<div class="sp-llm-form-actions">' +
      '<button type="button" data-llm-save-mcp class="sp-llm-btn is-primary">' + t('llm.save') + '</button>' +
      '<button type="button" data-llm-cancel-form class="sp-llm-btn">' + t('llm.cancel') + '</button>' +
      '</div></div>'
    );
  }

  /* ---------- 联网搜索 ---------- */
  function llmSearchHtml(t) {
    var search = LLM.search || {};
    var provider = search.provider || 'duckduckgo';
    var results = Math.max(3, Math.min(15, Number(search.results) || 6));
    var SEARCH_ENGINES = [
      { id: 'duckduckgo', name: 'DuckDuckGo', free: t('llm.searchDdg'), keyUrl: '' },
      { id: 'serper', name: 'Serper', free: t('llm.searchSerper'), keyUrl: 'https://serper.dev' },
      { id: 'tavily', name: 'Tavily', free: t('llm.searchTavily'), keyUrl: 'https://tavily.com' },
      { id: 'bing', name: 'Bing Search', free: t('llm.searchBing'), keyUrl: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api' },
      { id: 'google', name: 'Google Custom Search', free: t('llm.searchGoogle'), keyUrl: 'https://developers.google.com/custom-search/v1/overview' },
    ];
    var cards = SEARCH_ENGINES.map(function (se) {
      return (
        '<button type="button" class="sp-llm-search-card' + (se.id === provider ? ' is-active' : '') + '" data-llm-search-provider="' + se.id + '">' +
        '<span class="sp-llm-search-name">' + escLlm(se.name) + '</span>' +
        (se.id === provider ? '<span class="sp-llm-badge is-active">' + t('llm.searchSelected') + '</span>' : '') +
        '<span class="sp-field-desc">' + se.free + '</span>' +
        (se.keyUrl ? '<a class="sp-llm-link" href="' + se.keyUrl + '" target="_blank" rel="noreferrer">' + t('llm.searchApply') + '</a>' : '') +
        '</button>'
      );
    }).join('');
    return (
      '<div class="sp-llm-search-grid">' + cards + '</div>' +
      '<div class="sp-llm-searchbar">' +
      '<span class="sp-label">' + t('llm.searchResults') + '</span>' +
      '<div class="sp-llm-stepper">' +
      '<button type="button" class="sp-llm-btn" data-llm-search-dec aria-label="−">−</button>' +
      '<span class="sp-llm-stepper-val">' + results + ' ' + t('llm.searchItems') + '</span>' +
      '<button type="button" class="sp-llm-btn" data-llm-search-inc aria-label="+">+</button>' +
      '</div>' +
      '<span class="sp-field-desc">3–15</span>' +
      '</div>'
    );
  }

  function loadLlmPage() {
    App.api
      .get('/api/chat/providers')
      .then(function (catData) {
        LLM.catalog = (catData && catData.providers) || [];
        return App.api.get('/api/settings');
      })
      .catch(function () {
        LLM.catalog = [];
        return App.api.get('/api/settings');
      })
      .then(function (raw) {
        LLM.providers = llmParseArr(raw['llm:providers']);
        LLM.mcp = llmParseArr(raw['llm:mcp']);
        LLM.defaults = llmParseObj(raw['llm:defaults']);
        LLM.keys = llmParseObj(raw['llm:apikeys']);
        LLM.overrides = llmParseObj(raw['llm:overrides']);
        LLM.search = llmParseObj(raw['llm:search']);
        LLM.providerModels = llmParseObj(raw['llm:providerModels']);
        LLM.models = llmParseObj(raw['llm:models']);
        LLM.loaded = true;
        LLM.error = null;
        renderLlmPage();
      })
      .catch(function (e) {
        LLM.loaded = true;
        LLM.error = (e && e.message) || '加载失败';
        renderLlmPage();
      });
  }

  function llmSave(next) {
    var payload = {
      'llm:providers': JSON.stringify(next.providers || []),
      'llm:mcp': JSON.stringify(next.mcp || []),
      'llm:defaults': JSON.stringify(next.defaults || {}),
      'llm:apikeys': JSON.stringify(next.keys || {}),
      'llm:overrides': JSON.stringify(next.overrides || {}),
      'llm:search': JSON.stringify(next.search || {}),
      'llm:providerModels': JSON.stringify(next.providerModels || {}),
      'llm:models': JSON.stringify(next.models || {}),
    };
    App.api.put('/api/settings', { settings: payload }).then(function () {
      LLM.providers = next.providers || [];
      LLM.mcp = next.mcp || [];
      LLM.defaults = next.defaults || {};
      LLM.keys = next.keys || {};
      LLM.overrides = next.overrides || {};
      LLM.search = next.search || {};
      LLM.providerModels = next.providerModels || {};
      LLM.models = next.models || {};
      App.ui.toast(moduleT()('llm.saved'));
      renderLlmPage();
    }).catch(function (e) {
      App.ui.toast('保存失败: ' + ((e && e.message) || ''), 'error');
    });
  }

  function llmClone() {
    return {
      providers: (LLM.providers || []).slice(),
      mcp: JSON.parse(JSON.stringify(LLM.mcp || [])),
      defaults: JSON.parse(JSON.stringify(LLM.defaults || {})),
      keys: Object.assign({}, LLM.keys || {}),
      overrides: JSON.parse(JSON.stringify(LLM.overrides || {})),
      search: Object.assign({}, LLM.search || {}),
      providerModels: Object.assign({}, LLM.providerModels || {}),
      models: JSON.parse(JSON.stringify(LLM.models || {})),
    };
  }

  /** 把默认参数面板里正在编辑的输入同步回内存(下拉/重渲染前调用,避免丢输入) */
  function llmSyncDefaultsFromDom() {
    var d = LLM.defaults || {};
    LLM.defaults = d;
    var modelEl = document.querySelector('[data-llm-field="model"]');
    if (modelEl) d.model = modelEl.value.trim();
    var promptEl = document.querySelector('[data-llm-field="prompt"]');
    if (promptEl) d.prompt = promptEl.value;
    var params = d.params || {};
    d.params = params;
    var mt = document.querySelector('[data-llm-field="maxTokens"]');
    if (mt && mt.value.trim() !== '') {
      var parsed = llmParseTokens(mt.value);
      if (parsed != null) params.maxTokens = parsed;
    }
  }

  function llmFetchModelsFor(pid) {
    llmSyncDefaultsFromDom();
    var key = LLM.keys[pid] || '';
    LLM.fetching[pid] = true;
    renderLlmPage();
    App.api
      .post('/api/chat/models', { providerId: pid, apiKey: key })
      .then(function (data) {
        var list = (data && data.models) || [];
        var next = llmClone();
        next.models = Object.assign({}, next.models, {});
        next.models[pid] = list;
        if (LLM.defaults.provider === pid && list.length && !LLM.defaults.model) next.defaults.model = list[0];
        LLM.fetching[pid] = false;
        llmSave(next);
      })
      .catch(function (e) {
        LLM.fetching[pid] = false;
        LLM.models = Object.assign({}, LLM.models, {});
        LLM.models[pid] = [];
        App.ui.toast((e && e.message) || '获取模型失败', 'error');
        renderLlmPage();
      });
  }

  function llmCheckBalance(pid) {
    var key = LLM.keys[pid] || '';
    LLM.busy[pid] = true;
    renderLlmPage();
    App.api
      .post('/api/chat/balance', { providerId: pid, apiKey: key })
      .then(function (data) {
        LLM.busy[pid] = false;
        var bal = data && data.balance;
        var cur = (data && data.currency) || '';
        var text = '余额: ' + (Number.isFinite(Number(bal)) ? Number(bal).toLocaleString() : (bal || '-')) + (cur ? ' ' + cur : '');
        App.ui.toast(text);
        renderLlmPage();
      })
      .catch(function (e) {
        LLM.busy[pid] = false;
        App.ui.toast((e && e.message) || '查询余额失败', 'error');
        renderLlmPage();
      });
  }

  function llmFetchMcpTools(id) {
    var entry = (LLM.mcp || []).filter(function (s) { return s.id === id; })[0];
    if (!entry) return;
    LLM.busy[id] = true;
    renderLlmPage();
    App.api
      .post('/api/chat/mcp/tools', { url: entry.url, protocol: entry.protocol, headers: entry.headers })
      .then(function (data) {
        var list = (data && data.tools) || [];
        var next = llmClone();
        next.mcp = next.mcp.map(function (s) {
          if (s.id !== id) return s;
          return Object.assign({}, s, {
            tools: list.map(function (tt) {
              return { name: tt.name, description: tt.description || '', enabled: true };
            }),
          });
        });
        LLM.busy[id] = false;
        App.ui.toast('已获取 ' + list.length + ' 个工具');
        llmSave(next);
      })
      .catch(function (e) {
        LLM.busy[id] = false;
        App.ui.toast('获取工具失败: ' + ((e && e.message) || ''), 'error');
        renderLlmPage();
      });
  }

  function llmUid(prefix) {
    return (prefix || 'llm') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 分发 ---------- */
  var PAGES = {
    profile: pageProfile,
    account: pageAccount,
    appearance: pageAppearance,
    notifications: pageNotifications,
    display: pageDisplay,
    llm: pageLlm,
  };

  function render(route, ctx) {
    var t = ctx.t;
    var pageId = route === '/settings' ? 'profile' : route.split('/').pop();
    App.logger.debug('settings', '渲染子页面: ' + pageId); // 日志示例:自动带上 文件#函数:行号
    var renderer = PAGES[pageId] || null;
    var bodyHtml = renderer ? renderer(ctx) : App.ui.notFound(t);

    var navHtml = NAV.map(function (n) {
      var active = n.id === pageId;
      return (
        '<a href="#' +
        n.route +
        '" data-link="' +
        n.route +
        '" class="sp-nav-link' +
        (active ? ' is-active' : '') +
        '">' +
        icon().iconSvg(n.icon, { class: 'size-4' }) +
        '<span>' +
        t(n.titleKey) +
        '</span>' +
        '</a>'
      );
    }).join('');

    return (
      '<div class="sp-page">' +
      '<div class="sp-page-head">' +
      '<h1>' +
      t('settings.title') +
      '</h1>' +
      '<p>' +
      t('settings.description') +
      '</p>' +
      '</div>' +
      '<div class="sp-sep"></div>' +
      '<div class="sp-body">' +
      '<aside class="sp-nav-col"><nav class="sp-nav">' +
      navHtml +
      '</nav></aside>' +
      '<div class="sp-content">' +
      bodyHtml +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  /* ---------- 自定义控件事件委托(下拉选项 / 日历翻页与选日) ----------
   * 与核心层约定:真实 input 的 change/input 由 app.js 处理;纯按钮类自定义
   * 控件(下拉选项、日历日)在此处理,写值统一走 App.applySettingValue。
   */
  function moduleT() {
    var locale = App.getShellContext().settings.locale;
    return App.i18n.makeT(locale, window.__moduleI18n && window.__moduleI18n.settings);
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var opt = target.closest('[data-select-option]');
    if (opt) {
      App.applySettingValue(
        opt.getAttribute('data-setting'),
        opt.getAttribute('data-value'),
        false
      );
      return;
    }
    var calDay = target.closest('[data-calendar-day]');
    if (calDay) {
      App.applySettingValue('account.dob', calDay.getAttribute('data-value'), false);
      return;
    }
    var calClear = target.closest('[data-calendar-clear]');
    if (calClear) {
      App.applySettingValue('account.dob', '', false);
      return;
    }
    if (target.closest('[data-calendar-prev]') || target.closest('[data-calendar-next]')) {
      var delta = target.closest('[data-calendar-prev]') ? -1 : 1;
      if (calView) {
        calView.month += delta;
        if (calView.month < 0) {
          calView.month = 11;
          calView.year--;
        } else if (calView.month > 11) {
          calView.month = 0;
          calView.year++;
        }
        var t = moduleT();
        rerenderCalendar(t, App.getShellContext().settings.locale);
      }
      return;
    }
  });

  /* ---------- 大模型设置页交互(供应商/MCP CRUD、默认参数、模型获取、API Key) ---------- */
  function llmField(name) {
    var el = document.querySelector('[data-llm-f-' + name + ']');
    return el ? el.value : '';
  }
  function llmDefaultField(name) {
    var el = document.querySelector('[data-llm-field="' + name + '"]');
    return el ? el.value : '';
  }
  function llmNum(v, def) {
    var n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  function llmParseTokens(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    var m = s.match(/^([\d.]+)\s*(k|m)?$/);
    if (!m) {
      var n = Number(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    var num = parseFloat(m[1]);
    var mult = m[2] === 'm' ? 1000000 : m[2] === 'k' ? 1000 : 1;
    return Math.round(num * mult);
  }

  function llmSaveProvider() {
    var name = llmField('name').trim();
    var baseUrl = llmField('base').trim();
    var kind = (llmField('kind').trim() || 'openai').toLowerCase();
    if (!name) {
      App.ui.toast('名称必填', 'error');
      return;
    }
    var models = llmField('models')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    var id =
      (LLM.form && LLM.form.id) ||
      'cust-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var entry = {
      id: id,
      name: name,
      baseUrl: baseUrl,
      kind: kind === 'anthropic' ? 'anthropic' : 'openai',
      models: models,
    };
    var next = llmClone();
    var exists = next.providers.filter(function (p) { return p.id === id; })[0];
    if (exists) next.providers = next.providers.map(function (p) { return p.id === id ? entry : p; });
    else next.providers.push(entry);
    LLM.form = null;
    llmSave(next);
  }

  function llmSaveMcp() {
    var name = llmField('name').trim();
    var url = llmField('url').trim();
    var protocol = (llmField('protocol').trim() || 'https').toLowerCase();
    if (!url) {
      App.ui.toast('URL 必填', 'error');
      return;
    }
    var id = (LLM.form && LLM.form.id) || llmUid('mcp');
    var entry = {
      id: id,
      name: name || id,
      url: url,
      protocol: protocol === 'sse' ? 'sse' : 'https',
      enabled: true,
      tools: [],
    };
    var next = llmClone();
    var exists = next.mcp.filter(function (s) { return s.id === id; })[0];
    if (exists) entry = Object.assign({}, exists, entry, { enabled: exists.enabled !== false });
    if (exists) next.mcp = next.mcp.map(function (s) { return s.id === id ? entry : s; });
    else next.mcp.push(entry);
    LLM.form = null;
    llmSave(next);
  }

  function llmSaveDefaults() {
    llmSyncDefaultsFromDom();
    llmSave(llmClone());
  }

  document.addEventListener('app:afterRender', function (ev) {
    var detail = ev.detail || {};
    if (detail.path !== '/settings/llm') return;
    LLM.form = null;
    LLM.fetching = {};
    LLM.busy = {};
    loadLlmPage();
  });

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var addProvider = target.closest('[data-llm-add-provider]');
    if (addProvider) { LLM.form = { kind: 'provider', id: null }; renderLlmPage(); return; }
    var editProvider = target.closest('[data-llm-edit-provider]');
    if (editProvider) {
      LLM.form = { kind: 'provider', id: editProvider.getAttribute('data-llm-edit-provider') };
      renderLlmPage();
      return;
    }
    var delProvider = target.closest('[data-llm-del-provider]');
    if (delProvider) {
      var pid = delProvider.getAttribute('data-llm-del-provider');
      var nextP = llmClone();
      nextP.providers = nextP.providers.filter(function (p) { return p.id !== pid; });
      llmSave(nextP);
      return;
    }
    var saveProvider = target.closest('[data-llm-save-provider]');
    if (saveProvider) { llmSaveProvider(); return; }

    var addMcp = target.closest('[data-llm-add-mcp]');
    if (addMcp) { LLM.form = { kind: 'mcp', id: null }; renderLlmPage(); return; }
    var editMcp = target.closest('[data-llm-edit-mcp]');
    if (editMcp) {
      LLM.form = { kind: 'mcp', id: editMcp.getAttribute('data-llm-edit-mcp') };
      renderLlmPage();
      return;
    }
    var delMcp = target.closest('[data-llm-del-mcp]');
    if (delMcp) {
      var mid = delMcp.getAttribute('data-llm-del-mcp');
      var nextM = llmClone();
      nextM.mcp = nextM.mcp.filter(function (s) { return s.id !== mid; });
      llmSave(nextM);
      return;
    }
    var saveMcp = target.closest('[data-llm-save-mcp]');
    if (saveMcp) { llmSaveMcp(); return; }
    var mcpToggle = target.closest('[data-llm-mcp-toggle]');
    if (mcpToggle) {
      var mtid = mcpToggle.getAttribute('data-llm-mcp-toggle');
      var nextT = llmClone();
      nextT.mcp = nextT.mcp.map(function (s) {
        return s.id === mtid ? Object.assign({}, s, { enabled: !s.enabled }) : s;
      });
      llmSave(nextT);
      return;
    }
    var cancelForm = target.closest('[data-llm-cancel-form]');
    if (cancelForm) { LLM.form = null; renderLlmPage(); return; }

    var fetchModels = target.closest('[data-llm-fetch-models]');
    if (fetchModels) {
      llmFetchModelsFor(fetchModels.getAttribute('data-llm-fetch-models'));
      return;
    }
    var saveDefaults = target.closest('[data-llm-save-defaults]');
    if (saveDefaults) { llmSaveDefaults(); return; }

    var balance = target.closest('[data-llm-balance]');
    if (balance) { llmCheckBalance(balance.getAttribute('data-llm-balance')); return; }
    var mcpTools = target.closest('[data-llm-mcp-tools]');
    if (mcpTools) { llmFetchMcpTools(mcpTools.getAttribute('data-llm-mcp-tools')); return; }

    var searchP = target.closest('[data-llm-search-provider]');
    if (searchP) {
      var nextS = llmClone();
      nextS.search = Object.assign({}, nextS.search, { provider: searchP.getAttribute('data-llm-search-provider') });
      llmSave(nextS);
      return;
    }
    var searchDec = target.closest('[data-llm-search-dec]');
    if (searchDec) {
      var nextD = llmClone();
      nextD.search = Object.assign({}, nextD.search, { results: Math.max(3, (Number(nextD.search.results) || 6) - 1) });
      llmSave(nextD);
      return;
    }
    var searchInc = target.closest('[data-llm-search-inc]');
    if (searchInc) {
      var nextI = llmClone();
      nextI.search = Object.assign({}, nextI.search, { results: Math.min(15, (Number(nextI.search.results) || 6) + 1) });
      llmSave(nextI);
      return;
    }

    // 统一下拉选项(provider/thinking/maxtokens/model/pmodel/override 均经 data-llm-opt 编码)
    var opt = target.closest('[data-llm-opt]');
    if (opt) {
      var raw = opt.getAttribute('data-llm-opt') || '';
      var parts = raw.split(':');
      var kind = parts.shift();
      if (kind === 'provider') {
        llmSyncDefaultsFromDom();
        LLM.defaults.provider = parts.join(':');
        renderLlmPage();
      } else if (kind === 'thinking') {
        llmSyncDefaultsFromDom();
        LLM.defaults.thinking = parts[0];
        renderLlmPage();
      } else if (kind === 'maxtokens') {
        llmSyncDefaultsFromDom();
        if (!LLM.defaults.params) LLM.defaults.params = {};
        LLM.defaults.params.maxTokens = parseInt(parts[0], 10);
        renderLlmPage();
      } else if (kind === 'model') {
        llmSyncDefaultsFromDom();
        LLM.defaults.model = parts.join(':');
        renderLlmPage();
      } else if (kind === 'pmodel') {
        var ppid = parts[0];
        var pmodel = parts.slice(1).join(':');
        var nextPm = llmClone();
        if (pmodel) nextPm.providerModels[ppid] = pmodel;
        else delete nextPm.providerModels[ppid];
        if (nextPm.defaults.provider === ppid) nextPm.defaults.model = pmodel || '';
        llmSave(nextPm);
      } else if (kind === 'override') {
        var opid = parts[0];
        var oparam = parts[1];
        var oval = parts.slice(2).join(':');
        var nextOv = llmClone();
        nextOv.overrides[opid] = nextOv.overrides[opid] || {};
        if (oval === '') delete nextOv.overrides[opid][oparam];
        else nextOv.overrides[opid][oparam] = Number(oval);
        if (!Object.keys(nextOv.overrides[opid]).length) delete nextOv.overrides[opid];
        llmSave(nextOv);
      }
      return;
    }
  });

  /* 供应商卡片:API Key / 默认模型 输入失焦即自动保存 */
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.matches) return;
    if (el.matches('[data-llm-key]')) {
      var kid = el.getAttribute('data-llm-key');
      var v = el.value.trim();
      var nextK = llmClone();
      if (v) nextK.keys[kid] = v;
      else delete nextK.keys[kid];
      llmSave(nextK);
      return;
    }
    if (el.matches('[data-llm-pmodel]')) {
      var pmId = el.getAttribute('data-llm-pmodel');
      var pmVal = el.value.trim();
      var nextPM = llmClone();
      if (pmVal) nextPM.providerModels[pmId] = pmVal;
      else delete nextPM.providerModels[pmId];
      if (nextPM.defaults.provider === pmId) nextPM.defaults.model = pmVal || '';
      llmSave(nextPM);
      return;
    }
  });

  /* 设置页自研滑块(替代原生 range) */
  document.addEventListener('pointerdown', function (e) {
    var sl = e.target.closest ? e.target.closest('[data-sp-slider]') : null;
    if (!sl) return;
    e.preventDefault();
    llmSlider = {
      param: sl.getAttribute('data-sp-slider'),
      min: parseFloat(sl.getAttribute('data-min')),
      max: parseFloat(sl.getAttribute('data-max')),
      step: parseFloat(sl.getAttribute('data-step')),
    };
    spSliderFromEvent(sl, e);
  });
  document.addEventListener('pointermove', function (e) {
    if (!llmSlider) return;
    var sl = document.querySelector('[data-sp-slider="' + llmSlider.param + '"]');
    if (sl) spSliderFromEvent(sl, e);
  });
  document.addEventListener('pointerup', function () {
    llmSlider = null;
  });

  App.defineModule({ id: 'settings', render: render });
})();
