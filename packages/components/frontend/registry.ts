export type FrameworkKind = 'react' | 'vue' | 'js';
export type PlatformKind = 'web' | 'app';

export interface ComponentMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  platforms: PlatformKind[];
  frameworks: FrameworkKind[];
  files: Partial<Record<FrameworkKind, string>>;
  snippets: Partial<Record<FrameworkKind, string>>;
}

export const components: ComponentMeta[] = [
  // —— Web：ejunz-ui · Web ——
  {
    id: 'web-button',
    name: 'Button',
    category: '基础',
    description: 'Ejunz Web 按钮：primary（近黑）/ secondary / outline / ghost。',
    source: 'ejunz-ui · Web',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/button/WebButton.react.tsx',
      vue: 'frontend/web/button/WebButton.vue.ts',
      js: 'frontend/web/button/web-button.js',
    },
    snippets: {
      react: `import { WebButton } from '@ejunz/components';\n\n<WebButton variant="primary">Get Started</WebButton>`,
      vue: `import { WebButton } from '@ejunz/components/web/button/WebButton.vue';\n\nh(WebButton, { variant: 'primary' }, () => 'Get Started')`,
      js: `createWebButton(host, { label: 'Get Started', variant: 'primary' })`,
    },
  },
  {
    id: 'web-card',
    name: 'Card',
    category: '基础',
    description: 'Ejunz Web 文档卡片（圆角边框 + muted 描述）。',
    source: 'ejunz-ui · Web',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/card/WebCard.react.tsx',
      vue: 'frontend/web/card/WebCard.vue.ts',
      js: 'frontend/web/card/web-card.js',
    },
    snippets: {
      react: `<WebCard title="Getting Started" description="Install and configure Ejunz." />`,
      vue: `h(WebCard, { title: 'Getting Started', description: 'Install and configure Ejunz.' })`,
      js: `createWebCard(host, { title: 'Getting Started', description: 'Install and configure Ejunz.' })`,
    },
  },
  {
    id: 'web-callout',
    name: 'Callout',
    category: '基础',
    description: 'Ejunz Web Callout：info / warn / error。',
    source: 'ejunz-ui · Web',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/callout/WebCallout.react.tsx',
      vue: 'frontend/web/callout/WebCallout.vue.ts',
      js: 'frontend/web/callout/web-callout.js',
    },
    snippets: {
      react: `<WebCallout type="info" title="Tip">Use yarn build:ui after editing components.</WebCallout>`,
      vue: `h(WebCallout, { type: 'info', title: 'Tip' }, () => 'Use yarn build:ui after editing components.')`,
      js: `createWebCallout(host, { type: 'info', title: 'Tip', body: 'Use yarn build:ui after editing components.' })`,
    },
  },
  {
    id: 'web-feature',
    name: 'Feature',
    category: '首页',
    description: '首页产品入口卡（Ejunz / IoT / AI / KB）— 边框 + hover 阴影。',
    source: 'ejunz-ui · Web · docs.ejunz.com home',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/feature/WebFeature.react.tsx',
      vue: 'frontend/web/feature/WebFeature.vue.ts',
      js: 'frontend/web/feature/web-feature.js',
    },
    snippets: {
      react: `<WebFeature title="Ejunz" description="可部署，可扩展，可定制，可集成" />`,
      vue: `h(WebFeature, { title: 'Ejunz', description: '可部署，可扩展，可定制，可集成' })`,
      js: `createWebFeature(host, { title: 'Ejunz', description: '可部署，可扩展，可定制，可集成' })`,
    },
  },
  {
    id: 'web-repo-info',
    name: 'RepoInfo',
    category: '文档栏',
    description: '文档站 GitHub 徽章（owner/repo + stars，拉取失败也不报错）。',
    source: 'ejunz-ui · Web · docs.ejunz.com',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/repo-info/WebRepoInfo.react.tsx',
      vue: 'frontend/web/repo-info/WebRepoInfo.vue.ts',
      js: 'frontend/web/repo-info/web-repo-info.js',
    },
    snippets: {
      react: `<WebRepoInfo owner="ejunz-dev" repo="Ejunz" stars={1} />`,
      vue: `h(WebRepoInfo, { owner: 'ejunz-dev', repo: 'Ejunz', stars: 1 })`,
      js: `createWebRepoInfo(host, { owner: 'ejunz-dev', repo: 'Ejunz', stars: 1 })`,
    },
  },
  {
    id: 'web-root-toggle',
    name: 'RootToggle',
    category: '文档栏',
    description: '文档侧栏产品切换（Ejunz / IoT / AI / KB）。',
    source: 'ejunz-ui · Web · docs.ejunz.com sidebar',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/root-toggle/WebRootToggle.react.tsx',
      vue: 'frontend/web/root-toggle/WebRootToggle.vue.ts',
      js: 'frontend/web/root-toggle/web-root-toggle.js',
    },
    snippets: {
      react: `<WebRootToggle value="Ejunz" options={options} onChange={setProduct} />`,
      vue: `h(WebRootToggle, { value: 'Ejunz', options, onChange: setProduct })`,
      js: `createWebRootToggle(host, { value: 'Ejunz', options, onChange })`,
    },
  },
  {
    id: 'web-search-trigger',
    name: 'SearchTrigger',
    category: '文档栏',
    description: '文档侧栏搜索入口（Search · ⌘K）。',
    source: 'ejunz-ui · Web · docs.ejunz.com sidebar',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/search-trigger/WebSearchTrigger.react.tsx',
      vue: 'frontend/web/search-trigger/WebSearchTrigger.vue.ts',
      js: 'frontend/web/search-trigger/web-search-trigger.js',
    },
    snippets: {
      react: `<WebSearchTrigger onClick={openSearch} />`,
      vue: `h(WebSearchTrigger, { onClick: openSearch })`,
      js: `createWebSearchTrigger(host, { onClick: openSearch })`,
    },
  },
  {
    id: 'web-theme-toggle',
    name: 'ThemeToggle',
    category: '文档栏',
    description: '文档站亮/暗主题切换。',
    source: 'ejunz-ui · Web · docs.ejunz.com',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/theme-toggle/WebThemeToggle.react.tsx',
      vue: 'frontend/web/theme-toggle/WebThemeToggle.vue.ts',
      js: 'frontend/web/theme-toggle/web-theme-toggle.js',
    },
    snippets: {
      react: `<WebThemeToggle mode={mode} onChange={setMode} />`,
      vue: `h(WebThemeToggle, { mode, onChange: setMode })`,
      js: `createWebThemeToggle(host, { mode: 'dark', onChange })`,
    },
  },
  {
    id: 'web-sidebar',
    name: 'Sidebar',
    category: '文档栏',
    description: '文档站侧栏：分类目录 + 可选 banner（RootToggle / Search）。',
    source: 'ejunz-ui · Web · docs.ejunz.com sidebar',
    platforms: ['web'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/web/sidebar/WebSidebar.react.tsx',
      vue: 'frontend/web/sidebar/WebSidebar.vue.ts',
      js: 'frontend/web/sidebar/web-sidebar.js',
    },
    snippets: {
      react: `<WebSidebar groups={groups} header={{ title: '全部组件', href: '/components' }} />`,
      vue: `h(WebSidebar, { groups, header: { title: '全部组件', href: '/components' } })`,
      js: `createWebSidebar(host, { groups, header: { title: '全部组件' } })`,
    },
  },

  // —— App：ejunz-core-client ——
  {
    id: 'button',
    name: 'Button',
    category: '基础',
    description: 'Primary / secondary / ghost / danger — CTA 风格对齐 core-client（紫底深字）。',
    source: 'ejunz-core-client',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/button/Button.react.tsx',
      vue: 'frontend/app/button/Button.vue.ts',
      js: 'frontend/app/button/button.js',
    },
    snippets: {
      react: `import { Button } from '@ejunz/components';\n\n<Button variant="primary">继续</Button>`,
      vue: `import { Button } from '@ejunz/components/app/button/Button.vue';\n\nh(Button, { variant: 'primary' }, () => '继续')`,
      js: `createButton(host, { label: '继续', variant: 'primary' })`,
    },
  },
  {
    id: 'badge',
    name: 'Badge',
    category: '基础',
    description: '状态标签（与 Tag 同视觉语言）。',
    source: 'ejunz-core-client',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/badge/Badge.react.tsx',
      vue: 'frontend/app/badge/Badge.vue.ts',
      js: 'frontend/app/badge/badge.js',
    },
    snippets: {
      react: `<Badge tone="accent">Online</Badge>`,
      vue: `h(Badge, { tone: 'accent' }, () => 'Online')`,
      js: `createBadge(host, { label: 'Online', tone: 'accent' })`,
    },
  },
  {
    id: 'tag',
    name: 'Tag',
    category: '基础',
    description: '从 core-client 树/筛选芯片抽离的标签。',
    source: 'ejunz-core-client',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/tag/Tag.react.tsx',
      vue: 'frontend/app/tag/Tag.vue.ts',
      js: 'frontend/app/tag/tag.js',
    },
    snippets: {
      react: `<Tag tone="accent">parent</Tag>`,
      vue: `h(Tag, { tone: 'accent' }, () => 'parent')`,
      js: `createTag(host, { label: 'parent' })`,
    },
  },
  {
    id: 'card',
    name: 'Card',
    category: '展示',
    description: '深色 surface 卡片。',
    source: 'ejunz-core-client',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/card/Card.react.tsx',
      vue: 'frontend/app/card/Card.vue.ts',
      js: 'frontend/app/card/card.js',
    },
    snippets: {
      react: `<Card title="Exporter">Connected.</Card>`,
      vue: `h(Card, { title: 'Exporter' }, () => 'Connected.')`,
      js: `createCard(host, { title: 'Exporter', body: 'Connected.' })`,
    },
  },
  {
    id: 'empty-state',
    name: 'EmptyState',
    category: '展示',
    description: 'core-client EmptyState：accent “—” + 文案。',
    source: 'ejunz-core-client/app/src/components/EmptyState.vue',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/empty-state/EmptyState.react.tsx',
      vue: 'frontend/app/empty-state/EmptyState.vue.ts',
      js: 'frontend/app/empty-state/empty-state.js',
    },
    snippets: {
      react: `<EmptyState text="暂无已加入的 Domain" />`,
      vue: `h(EmptyState, { text: '暂无已加入的 Domain' })`,
      js: `createEmptyState(host, { text: '暂无已加入的 Domain' })`,
    },
  },
  {
    id: 'app-shell',
    name: 'AppShell',
    category: '布局',
    description: 'core-client 顶栏：eyebrow + title + online-dot + meta 行。',
    source: 'ejunz-core-client/app/src/components/AppShell.vue',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/app-shell/AppShell.react.tsx',
      vue: 'frontend/app/app-shell/AppShell.vue.ts',
      js: 'frontend/app/app-shell/app-shell.js',
    },
    snippets: {
      react: `<AppShell eyebrow="EJUNZ CORE" title="我的空间" metaLeft="https://host" metaRight="退出登录">...</AppShell>`,
      vue: `h(AppShell, { eyebrow: 'EJUNZ CORE', title: '我的空间' }, () => children)`,
      js: `createAppShell(host, { eyebrow: 'EJUNZ CORE', title: '我的空间' })`,
    },
  },
  {
    id: 'bottom-nav',
    name: 'BottomNav',
    category: '布局',
    description: 'core-client 底栏导航；窄屏仅图标。',
    source: 'ejunz-core-client/app/src/components/BottomNav.vue',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/bottom-nav/BottomNav.react.tsx',
      vue: 'frontend/app/bottom-nav/BottomNav.vue.ts',
      js: 'frontend/app/bottom-nav/bottom-nav.js',
    },
    snippets: {
      react: `<BottomNav current="home" items={items} onChange={setTab} />`,
      vue: `h(BottomNav, { current: 'home', items, onChange: setTab })`,
      js: `createBottomNav(host, { current: 'home', items, onChange })`,
    },
  },
  {
    id: 'stat-card',
    name: 'StatCard',
    category: '展示',
    description: '统计卡（已对齐 --app-* token）。',
    source: 'ejunz-core-client/app/src/components/StatCard.vue',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/stat-card/StatCard.react.tsx',
      vue: 'frontend/app/stat-card/StatCard.vue.ts',
      js: 'frontend/app/stat-card/stat-card.js',
    },
    snippets: {
      react: `<StatCard label="Domains" value={12} />`,
      vue: `h(StatCard, { label: 'Domains', value: 12 })`,
      js: `createStatCard(host, { label: 'Domains', value: 12 })`,
    },
  },
  {
    id: 'switch',
    name: 'Switch',
    category: '基础',
    description: '从 BaseDetailSettingsPanel 抽离的开关。',
    source: 'ejunz-core-client/app/src/components/BaseDetailSettingsPanel.vue',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/switch/Switch.react.tsx',
      vue: 'frontend/app/switch/Switch.vue.ts',
      js: 'frontend/app/switch/switch.js',
    },
    snippets: {
      react: `<Switch checked={on} onChange={setOn} />`,
      vue: `h(Switch, { checked: on, 'onUpdate:checked': setOn })`,
      js: `createSwitch(host, { checked: true, onChange })`,
    },
  },
  {
    id: 'list-row',
    name: 'ListRow',
    category: '展示',
    description: 'core-client Domain/Base 列表行（头像 + 标题 + 简介 + ›）。',
    source: 'ejunz-core-client/app/src/pages/home/index.vue',
    platforms: ['app'],
    frameworks: ['react', 'vue', 'js'],
    files: {
      react: 'frontend/app/list-row/ListRow.react.tsx',
      vue: 'frontend/app/list-row/ListRow.vue.ts',
      js: 'frontend/app/list-row/list-row.js',
    },
    snippets: {
      react: `<ListRow title="Demo" description="简介" meta="demo" />`,
      vue: `h(ListRow, { title: 'Demo', description: '简介', meta: 'demo' })`,
      js: `createListRow(host, { title: 'Demo', description: '简介', meta: 'demo' })`,
    },
  },

  // —— Legacy Ejunz components ———
  {
    id: 'legacy-autocomplete',
    name: 'AutoComplete',
    category: 'Legacy',
    description: 'Ejunz legacy autocomplete control. Requires host-provided query and selection callbacks.',
    source: 'Ejunz legacy frontend',
    platforms: ['web'],
    frameworks: ['react'],
    files: {
      react: 'frontend/web/autocomplete/AutoComplete.tsx',
    },
    snippets: {
      react: `import { AutoComplete } from '@ejunz/components';\n\n<AutoComplete items={items} onSelect={onSelect} />`,
    },
  },
  {
    id: 'legacy-custom-select-autocomplete',
    name: 'CustomSelectAutoComplete',
    category: 'Legacy',
    description: 'Ejunz legacy data-backed autocomplete wrapper.',
    source: 'Ejunz legacy frontend',
    platforms: ['web'],
    frameworks: ['react'],
    files: {
      react: 'frontend/web/autocomplete/CustomSelectAutoComplete.tsx',
    },
    snippets: {
      react: `import { CustomSelectAutoComplete } from '@ejunz/components';`,
    },
  },
  {
    id: 'legacy-config-editor',
    name: 'ConfigEditor',
    category: 'Legacy',
    description: 'Ejunz configuration editor; requires Monaco, schema, Markdown, and host save/action handlers.',
    source: 'Ejunz legacy frontend',
    platforms: ['web'],
    frameworks: ['react'],
    files: {
      react: 'frontend/web/config-editor/ConfigEditor.tsx',
    },
    snippets: {
      react: `import { ConfigEditor } from '@ejunz/components';\n\n<ConfigEditor config={config} onSave={onSave} />`,
    },
  },
  {
    id: 'legacy-icon',
    name: 'Icon',
    category: 'Legacy',
    description: 'Ejunz legacy icon span component.',
    source: 'Ejunz legacy frontend',
    platforms: ['web'],
    frameworks: ['react'],
    files: {
      react: 'frontend/web/icon/Icon.tsx',
    },
    snippets: {
      react: `import { Icon } from '@ejunz/components';\n\n<Icon name="check" />`,
    },
  },
  {
    id: 'legacy-notification',
    name: 'Notification',
    category: 'Legacy',
    description: 'Ejunz legacy toast service; requires a mounted ComponentsProvider/ToastContainer.',
    source: 'Ejunz legacy frontend',
    platforms: ['web'],
    frameworks: ['react'],
    files: {
      react: 'frontend/web/notification/Notification.tsx',
    },
    snippets: {
      react: `import { Notification } from '@ejunz/components';\n\nNotification.success('Saved')`,
    },
  },
  {
    id: 'legacy-components-provider',
    name: 'ComponentsProvider',
    category: 'Legacy',
    description: 'Ejunz legacy provider for i18n/config context and toast rendering.',
    source: 'Ejunz legacy frontend',
    platforms: ['web'],
    frameworks: ['react'],
    files: {
      react: 'frontend/web/provider.tsx',
    },
    snippets: {
      react: `import { ComponentsProvider } from '@ejunz/components';\n\n<ComponentsProvider>{children}</ComponentsProvider>`,
    },
  },
];

export function listComponents(platform?: PlatformKind) {
  return components
    .filter((item) => !platform || item.platforms.includes(platform))
    .map(({ snippets: _s, ...rest }) => rest);
}

export function getComponent(id: string) {
  return components.find((item) => item.id === id);
}

export function listCategories(platform?: PlatformKind) {
  const items = listComponents(platform);
  const order: string[] = [];
  const map = new Map<string, ReturnType<typeof listComponents>>();
  for (const item of items) {
    if (!map.has(item.category)) {
      map.set(item.category, []);
      order.push(item.category);
    }
    map.get(item.category)!.push(item);
  }
  return order.map((category) => ({ category, components: map.get(category)! }));
}
