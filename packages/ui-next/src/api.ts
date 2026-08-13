// Components
export { Link, type LinkProps } from './components/link';
export { Card, type CardProps } from './components/card';
export { List, ListItem, type ListItemProps, type ListProps } from './components/list';
export { Button, type ButtonProps, type ButtonVariant } from './components/button';
export { Tag, type TagProps } from './components/tag';
export { Callout, type CalloutProps, type CalloutType } from './components/callout';

// Context
export { type PageData, usePageData } from './context/page-data';
export { type RouterState, useNavigate, useRouterState } from './context/router';
export { useBuildUrl } from './hooks/use-build-url';

// Registry
export type {
  Interceptor, InterceptorEntry, InterceptorOptions,
  PluginAPI, PluginDefinition,
  SlotName,
} from './registry';
export { defineSlot } from './registry';

// Shared dependencies
export { default as React } from 'react';
export { default as ReactDOM } from 'react-dom/client';
export { default as jsxRuntime } from 'react/jsx-runtime';
