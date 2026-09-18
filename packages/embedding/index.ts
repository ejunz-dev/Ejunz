import type { Context } from 'ejun/src/context';
import EmbeddingService from './src/embedding/service';

export const inject = ['server', 'loader'];

export * from './src/embedding';
export { default as EmbeddingService } from './src/embedding/service';

export async function apply(ctx: Context) {
    await ctx.plugin(EmbeddingService);
    await ctx.loader.reloadPlugin(require.resolve('./src/tool'), '');
    await ctx.loader.reloadPlugin(require.resolve('./src/script'), '');
}
