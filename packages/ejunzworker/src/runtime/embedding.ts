let runtimePromise: Promise<any> | null = null;

function unwrap(module: any) {
    return module?.default || module;
}

async function createEmbeddingRuntimeContext() {
    require('ejun/src/init');
    const ctx = (global as any).app;
    if (!ctx) throw new Error('Failed to initialize Ejunz runtime context');

    require('ejun/src/utils');
    require('ejun/src/error');
    require('ejun/src/service/bus').apply(ctx);

    const { MongoService } = require('ejun/src/service/db');
    const { load } = require('ejun/src/options');
    const { SettingService } = require('ejun/src/settings');
    const SystemModel = unwrap(require('ejun/src/model/system'));

    await ctx.plugin(MongoService, load() || {});
    await ctx.plugin(SettingService);
    await ctx.plugin(SystemModel.Service);
    await new Promise((resolve) => {
        ctx.inject(['setting', 'db', 'model:system'], resolve);
    });

    require('ejun/src/model/document');
    require('ejun/src/model/base');
    await ctx.plugin(unwrap(require('ejun/src/service/embedding')));
    await new Promise((resolve) => {
        ctx.inject(['db', 'embedding'], resolve);
    });

    return ctx;
}

export function getEmbeddingRuntimeContext() {
    runtimePromise ||= createEmbeddingRuntimeContext();
    return runtimePromise;
}
