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
        if (id !== resolvedVirtualModuleId) return undefined;
        let entries: Record<string, string> = {};
        try {
            entries = JSON.parse(process.env.EJUNZ_UI_SSR_ENTRIES || '{}');
        } catch {
            // Keep the standalone client build usable without the Ejunz server.
        }
        if (!Object.keys(entries).length) return 'export default [];';
        const imports = Object.values(entries).map((entry, i) => `import * as plugin${i} from '${entry}';`).join('\n');
        const plugins = Object.keys(entries).map((name, i) => `{ name: ${JSON.stringify(name)}, ...plugin${i} }`).join(', ');
        return `${imports}\nexport default [${plugins}];`;
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
        dedupe: ['react', 'react-dom'],
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
