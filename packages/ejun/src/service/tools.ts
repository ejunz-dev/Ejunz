import fs from 'fs-extra';
import path from 'path';
import { Context } from '../context';
import ToolService from './registry';

export { default as ToolService } from './registry';
export { createProvider } from './provider';
export { schemaToJsonSchema } from '../lib/tool-schema';
export * from '../lib/tool-limits';
export type { Provider, ProviderScope } from './provider';
export type {
    RegisteredTool, ToolAccess, ToolBindBase, ToolDeclaration, ToolDefinition, ToolExecute,
    ToolInstructionsContext, ToolRegisterOptions, ToolSource,
} from './registry';
export type {
    SystemToolExecutionContext,
    ToolArgs,
    ToolBaseSelectPayload,
    ToolCalledPayload,
    ToolContext,
    ToolSpec,
} from '../lib/tool-types';

export async function apply(ctx: Context) {
    await ctx.plugin(ToolService);
    const toolsDir = path.resolve(__dirname, '../tools');
    for (const name of await fs.readdir(toolsDir)) {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const file = path.resolve(toolsDir, name);
        if (typeof require(file).apply !== 'function') continue;
        await ctx.loader.reloadPlugin(file, '');
    }
}
