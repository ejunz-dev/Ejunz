export { default as UiNextApp } from './src/app';
export { PageDataProvider, usePageData, useSetPageData, useUiContext, useUserContext } from './src/context/page-data';
export type { PageData } from './src/context/page-data';
export { RouterProvider, useNavigate, useRouterState } from './src/context/router';
export type { RouterState } from './src/context/router';
export { initialPage, isInjected, pluginsUrl, routeMapStore } from './src/globals';
export { registerLayout } from './src/registry/layout';
export { registerPage } from './src/registry/page';
export { defineSlot, installPlugin } from './src/registry';
export type { LayoutComponent } from './src/registry/layout';
export type {
  PageEntry,
  PageLoader,
  RegisterPageOptions,
} from './src/registry/types';
