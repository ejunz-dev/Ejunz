/// <reference types="vite/client" />

declare module 'virtual:ejunz-plugins' {
    import type { PluginDefinition } from './registry';
    const plugins: PluginDefinition[];
    export default plugins;
}
