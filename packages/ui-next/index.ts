import fs from 'fs';
import path from 'path';
import esbuild from 'esbuild';
import c2k from 'koa2-connect/ts';
import { createServer, type Plugin } from 'vite';
import { HandlerCommon, serializer } from '@ejunz/framework';
import {
    Context, Handler, Logger,
    NotFoundError, param, SettingModel, sha1, size, Types,
} from 'ejun';
import { renderDomPage } from './src/entry-dom';
import { installPlugin } from './src/dom/registry';
import './src/pages';

const logger = new Logger('ui-next');

const PENDING_HTML = `<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ejunz</title>
    <meta http-equiv="refresh" content="3">
</head>
<body>
    <p>Ejunz UI is building, please wait and refresh...</p>
</body>
</html>`;

const INJECT_MARKER = '<!-- __EJUNZ_INJECTION__DO_NOT_REMOVE_THIS__ -->';
const buildInject = (data: string) => `<script id="__EJUNZ_INJECTION__" type="application/json">${data}</script>`;

function getAddonEntries(): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const [name, addon] of Object.entries(global.addons)) {
        const uiEntry = ['ui/index.ts', 'ui/index.tsx', 'ui/index.js', 'ui/index.jsx']
            .map((f) => path.resolve(addon as string, f))
            .find((f) => fs.existsSync(f));
        if (uiEntry) {
            logger.info('UI entry for addon %s: %s', name, uiEntry);
            entries[name] = uiEntry;
        }
    }
    return entries;
}

let domPluginsReady: Promise<void> | undefined;

async function ensureDomPlugins() {
    if (!domPluginsReady) {
        domPluginsReady = (async () => {
            for (const [name, entry] of Object.entries(getAddonEntries())) {
                try {
                    const plugin = require(entry) as { setup?: (api: any) => void };
                    if (typeof plugin.setup === 'function') {
                        installPlugin({ name, setup: plugin.setup });
                    }
                } catch (error) {
                    logger.warn('Failed to load DOM UI plugin %s: %o', name, error);
                }
            }
        })();
    }
    await domPluginsReady;
}

function createPageData(args: Record<string, any>, context: any) {
    const host = context.handler.context.req.headers?.host || 'localhost';
    return {
        name: context.handler.context._matchedRouteName,
        template: context.handler.response.template || '',
        args: {
            UserContext: context.UserContext,
            UiContext: context.handler.UiContext,
            ...args,
        },
        url: context.handler.context.req.url!,
        host,
    };
}

async function renderDom(
    html: string,
    pageData: ReturnType<typeof createPageData>,
    routeMap: Record<string, string>,
) {
    try {
        await ensureDomPlugins();
        const rendered = renderDomPage(pageData, routeMap, pageData.host);
        return html.replace('<div id="root"></div>', `<div id="root">${rendered}</div>`);
    } catch (error) {
        logger.warn('DOM render failed for %s: %o', pageData.name, error);
        return html;
    }
}

function ejunzPlugins(): Plugin {
    const virtualModuleId = 'virtual:ejunz-plugins';
    const resolvedVirtualModuleId = `\0${virtualModuleId}`;

    return {
        name: 'ejunz-plugins',
        resolveId(id) {
            if (id === virtualModuleId) {
                return resolvedVirtualModuleId;
            }
            return undefined;
        },
        load(id) {
            if (id === resolvedVirtualModuleId) {
                const entries = getAddonEntries();
                if (!Object.keys(entries).length) return 'export default [];';
                const imports = Object.entries(entries).map(([_, e], i) => `import * as plugin${i} from '${e}';`).join('\n');
                const exports = `export default [${Object.entries(entries).map(([addon, _], i) => {
                    return `{ name: '${addon}', ...plugin${i} }`;
                }).join(', ')}];`;
                return `${imports}\n${exports}`;
            }
            return undefined;
        },
    };
}

const federationPlugin: esbuild.Plugin = {
    name: 'federation',
    setup(b) {
        const mappings: Record<string, string> = {
            react: 'React',
            'react-dom/client': 'ReactDOM',
            'react/jsx-runtime': 'jsxRuntime',
        };

        b.onResolve({ filter: /^@ejunz\/ui-next/ }, () => ({
            path: 'ui-next',
            namespace: 'ejunz-federation',
        }));
        for (const mod of Object.keys(mappings)) {
            b.onResolve({ filter: new RegExp(`^${mod.replaceAll('\\', '\\\\').replaceAll('/', '\\/')}$`) }, () => ({
                path: mod,
                namespace: 'ejunz-federation',
            }));
        }
        b.onLoad({ filter: /.*/, namespace: 'ejunz-federation' }, (args) => {
            if (args.path === 'ui-next') {
                return { contents: 'module.exports = window.__ejunzExports;', loader: 'js' };
            }
            const key = mappings[args.path];
            return { contents: `module.exports = window.__ejunzExports['${key}'];`, loader: 'js' };
        });
    },
};

const vfs: Record<string, string> = {};
const hashes: Record<string, string> = {};

const applyCss = (css: string) => `
(() => {
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(css)};
  document.head.appendChild(style);
})();
`;

function addFile(name: string, content: string) {
    vfs[name] = content;
    hashes[name] = sha1(content).substring(0, 8);
}

async function buildI18n() {
    const localeList: Record<string, { name: string, flag: string }> = {};
    for (const lang in global.Ejunz.locales) {
        if (!/^[a-zA-Z_]+$/.test(lang)) continue;
        if (!global.Ejunz.locales[lang].__interface) continue;
        addFile(`lang-${lang}.js`, `window.EjunzLocale=${JSON.stringify(global.Ejunz.locales[lang][Symbol.for('iterate')])};`);
        const id = global.Ejunz.locales[lang].__id;
        if (id) localeList[id] = { name: global.Ejunz.locales[lang].__langname, flag: global.Ejunz.locales[lang].__flag };
    }
    addFile('locale-list.js', `window.EjunzLocaleList=${JSON.stringify(localeList)};`);
}

async function buildCodeLangs() {
    addFile('code-langs.js', `window.EjunzCodeLangs=${JSON.stringify(SettingModel.langs)};`);
}

async function buildVersions() {
    const versions: Record<string, string> = { ...global.Ejunz.version };
    try {
        const { simpleGit } = require('simple-git') as typeof import('simple-git');
        const fetchAddonVersion = async (name: string, addonPath: string) => {
            try {
                const git = simpleGit(addonPath);
                const [log, status] = await Promise.all([git.log(), git.status()]);
                if (log.all.length > 0) {
                    let hash = log.all[0].hash.substring(0, 7);
                    if (!status.isClean()) hash += '-dirty';
                    versions[name] = versions[name] ? `${versions[name]}-${hash}` : hash;
                }
            } catch (e) {
                logger.debug('Could not get git hash for addon %s: %o', name, e);
            }
        };
        await Promise.all(
            Object.entries(global.addons)
                .filter(([name]) => name !== 'ejun') // already handled in loader.ts
                .map(([name, addonPath]) => fetchAddonVersion(name, addonPath as string)),
        );
    } catch (e) {
        logger.debug('simple-git not available: %o', e);
    }
    addFile('versions.js', `window.EjunzVersions=${JSON.stringify(versions)};`);
}

class UiNextConstantHandler extends Handler {
    noCheckPermView = true;

    @param('name', Types.Filename)
    async all(domainId: string, name: string) {
        if (!(name in vfs)) throw new NotFoundError(name);
        this.response.type = 'application/javascript';
        this.response.body = vfs[name];
        this.response.addHeader('ETag', hashes[name]);
        this.response.addHeader('Cache-Control', 'public, max-age=86400');
    }
}

export async function buildPlugins() {
    const start = Date.now();
    let totalSize = 0;
    const entries = getAddonEntries();

    const newPluginFiles = new Set<string>();
    const emit = (name: string, content: string) => {
        addFile(name, content);
        newPluginFiles.add(name);
    };
    const purge = () => {
        for (const key of Object.keys(vfs)) {
            if (!newPluginFiles.has(key)) {
                delete vfs[key];
                delete hashes[key];
            }
        }
    };

    if (!Object.keys(entries).length) {
        emit('plugins.js', 'window.__ejunzPlugins = [];');
        purge();
        logger.info('No plugins to build');
        return;
    }

    try {
        const result = await esbuild.build({
            stdin: {
                contents: [
                    ...Object.entries(entries).map(([_, e], i) => `import * as plugin${i} from '${e}';`),
                    `window.__ejunzPlugins = [${Object.entries(entries).map(([n], i) => `{ name: '${n}', ...plugin${i} }`).join(', ')}];`,
                ].join('\n'),
                sourcefile: 'plugins.ts',
                resolveDir: process.cwd(),
                loader: 'ts',
            },
            bundle: true,
            format: 'esm',
            splitting: true,
            outdir: 'plugins-dist',
            entryNames: 'plugins',
            chunkNames: 'chunk-[hash]',
            assetNames: 'asset-[hash]',
            metafile: true,
            write: false,
            target: ['chrome90'],
            plugins: [federationPlugin],
            minify: true,
            jsx: 'automatic',
            jsxImportSource: 'react',
        });
        if (result.errors.length) logger.error('Plugin build errors: %o', result.errors);

        const cssText = new Map<string, string>();
        for (const f of result.outputFiles) {
            if (f.path.endsWith('.css')) cssText.set(f.path, f.text);
        }

        const cssForJs = new Map<string, string>();
        const claimed = new Set<string>();
        for (const [rel, meta] of Object.entries(result.metafile.outputs)) {
            if (!meta.cssBundle) continue;
            const css = path.resolve(meta.cssBundle);
            cssForJs.set(path.resolve(rel), css);
            claimed.add(css);
        }

        let unclaimedCss = '';
        for (const [abs, text] of cssText) {
            if (!claimed.has(abs)) unclaimedCss += text;
        }

        for (const f of result.outputFiles) {
            if (f.path.endsWith('.css')) continue;

            const name = path.basename(f.path);
            let content = f.text;

            const css = cssText.get(cssForJs.get(f.path) ?? '');
            if (css) content = applyCss(css) + content;
            if (name === 'plugins.js' && unclaimedCss) content = applyCss(unclaimedCss) + content;

            totalSize += content.length;
            emit(name, content);
        }

        purge();
        logger.success('Plugins built in %dms (%d entries, %s)', Date.now() - start, Object.keys(entries).length, size(totalSize));
    } catch (e) {
        logger.error('Plugin build failed: %o', e);
    }
}

const HASH_FALLBACK = '00000000';

const getViewLang = (handler: HandlerCommon) => handler.user?.viewLang || handler.session?.viewLang || 'zh';

const injectedScripts = (resolve: (name: string) => string, viewLang: string) => [
    'code-langs.js',
    'locale-list.js',
    `lang-${viewLang}.js`,
    'versions.js',
].map((name) => `<script src="${resolve(name)}"></script>`);

export async function apply(ctx: Context) {
    if (process.env.EJUNZ_CLI) return;

    ctx.Route('ui_next_constants', '/plugins/:version/:name', UiNextConstantHandler);

    if (process.env.DEV) {
        ctx.on('app/started', async () => {
            await buildI18n();
            await buildCodeLangs();
            await buildVersions();
        });
        ctx.on('app/i18n/update', buildI18n);
        ctx.on('system/setting-loaded', buildCodeLangs);
        ctx.on('system/setting', buildCodeLangs);

        const vite = await createServer({
            root: __dirname,
            clearScreen: false,
            server: {
                middlewareMode: true,
                hmr: {
                    port: 3010,
                },
                headers: {
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                },
            },
            appType: 'custom',
            plugins: [ejunzPlugins()],
        });
        const middleware = c2k(vite.middlewares);
        const capture = ['/@vite/', '/src/', '/node_modules/', '/@react-refresh', '/@fs', '/@id/'];
        for (const route of capture) {
            ctx.server.addCaptureRoute(route, middleware);
        }
        const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
        ctx.server.registerRenderer('next', {
            name: 'next',
            accept: [],
            output: 'html',
            asFallback: true,
            priority: 100,
            async render(_name, args, context) {
                const pageData = createPageData(args, context);
                const serialized = JSON.stringify({
                    EJUNZ_INJECTED: true,
                    ...pageData,
                    route_map: ctx.server.routeMap,
                    endpoint: ctx.setting.get('server.url') || undefined,
                }, serializer(false, context.handler));
                const ts = Date.now();
                const devAssetUrl = (name: string) => `/plugins/0/${name}?_=${ts}`;
                const injectHtml = [
                    buildInject(serialized),
                    ...injectedScripts(devAssetUrl, getViewLang(context.handler)),
                ].join('\n');
                const injectedHtml = html.replace(INJECT_MARKER, injectHtml);
                const renderedHtml = await renderDom(injectedHtml, pageData, ctx.server.routeMap);
                return await vite.transformIndexHtml(context.handler.context.req.url!, renderedHtml);
            },
        });

        // eslint-disable-next-line consistent-return
        return async () => {
            await vite.close().catch((e) => logger.error('Failed to close Vite SSR server: %o', e));
        };
    } else {
        const build = async () => {
            await buildPlugins();
            await buildI18n();
            await buildCodeLangs();
            await buildVersions();
        };
        ctx.on('app/started', build);

        ctx.server.registerRenderer('next', {
            name: 'next',
            accept: [],
            output: 'html',
            asFallback: true,
            priority: 100,
            async render(_name, args, context) {
                const indexHtml = path.join(__dirname, 'public', 'index.html');
                if (!fs.existsSync(indexHtml)) return PENDING_HTML;
                const html = fs.readFileSync(indexHtml, 'utf-8');
                const pageData = createPageData(args, context);
                const serialized = JSON.stringify({
                    EJUNZ_INJECTED: true,
                    ...pageData,
                    route_map: ctx.server.routeMap,
                    endpoint: ctx.setting.get('server.url') || undefined,
                    plugins_url: `/plugins/${hashes['plugins.js'] || HASH_FALLBACK}/plugins.js`,
                }, serializer(false, context.handler));
                const prodAssetUrl = (name: string) => `/plugins/${hashes[name] || HASH_FALLBACK}/${name}`;
                const injectHtml = [
                    buildInject(serialized),
                    ...injectedScripts(prodAssetUrl, getViewLang(context.handler)),
                ].join('\n');
                const injectedHtml = html.replace(INJECT_MARKER, injectHtml);
                return renderDom(injectedHtml, pageData, ctx.server.routeMap);
            },
        });
        const debouncedBuild = ctx.debounce(build, 2000);
        const triggerHotUpdate = (filePath?: string) => {
            if (filePath && !filePath.includes('/ui/')) return;
            debouncedBuild();
        };
        ctx.on('app/watch/change', triggerHotUpdate);
        ctx.on('app/watch/unlink', triggerHotUpdate);
        ctx.on('system/setting-loaded', buildCodeLangs);
        ctx.on('system/setting', debouncedBuild);
        ctx.on('app/i18n/update', debouncedBuild);
    }
}
