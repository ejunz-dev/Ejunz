import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const virtualModuleId = 'virtual:ejunz-plugins';
const resolvedVirtualModuleId = `\0${virtualModuleId}`;

const buildPlugins = (): Plugin => ({
    name: 'ejunz-plugins-build',
    resolveId(id) {
        return id === virtualModuleId ? resolvedVirtualModuleId : undefined;
    },
    load(id) {
        return id === resolvedVirtualModuleId ? 'export default [];' : undefined;
    },
});

export default defineConfig(({ command }) => ({
    root: __dirname,
    base: '/',
    plugins: [react(), ...(command === 'build' ? [buildPlugins()] : [])],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
            '@ejunz/ui-next': path.resolve(__dirname, 'src/api.ts'),
        },
    },
    publicDir: 'pub',
    build: {
        outDir: 'public',
        emptyOutDir: true,
        rolldownOptions: {
            output: {
                codeSplitting: true,
            },
        },
    },
    worker: { format: 'es' },
}));
