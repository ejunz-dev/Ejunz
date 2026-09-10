/**
 * The Ejunz Base tool set, registered into the Ejunz tool registry.
 *
 * The implementations live in this package; the declarations they are published
 * under (names, descriptions, JSON Schemas) come from the shared catalog, which
 * keeps one definition of each tool. Plugging `apply` publishes the set under the
 * source id `base`, which is what the MCP server, the tool provider, and the
 * Ejunz Agent bridge read.
 * @module
 */
import type { Context } from 'ejun/src/context';
import ToolService from './registry';
import type { ToolDeclaration } from './registry';
import {
    BUILTIN_TOOLS_CATALOG,
    isBuiltinMutatingTool,
    type ToolDef,
} from './catalog';
import type { ToolArgs, ToolContext } from './types';
import * as baseCreate from './base/create';
import * as baseDelete from './base/delete';
import * as baseGet from './base/get';
import * as baseList from './base/list';
import * as baseSearch from './base/search';
import * as baseUpdate from './base/update';
import * as semanticSearch from './base/semantic-search';
import * as cardCreate from './base/card/create';
import * as cardDelete from './base/card/delete';
import * as cardGet from './base/card/get';
import * as cardUpdate from './base/card/update';
import * as fileCreate from './base/file/create';
import * as fileDelete from './base/file/delete';
import * as fileGet from './base/file/get';
import * as fileList from './base/file/list';
import * as gitCommit from './base/git/commit';
import * as gitConfigGet from './base/git/config-get';
import * as gitConfigSet from './base/git/config-set';
import * as gitPull from './base/git/pull';
import * as gitPush from './base/git/push';
import * as gitStatus from './base/git/status';
import * as nodeCreate from './base/node/create';
import * as nodeDelete from './base/node/delete';
import * as nodeGet from './base/node/get';
import * as nodeUpdate from './base/node/update';
import * as problemCreate from './base/problem/create';
import * as problemDelete from './base/problem/delete';
import * as problemGet from './base/problem/get';
import * as problemList from './base/problem/list';
import * as problemUpdate from './base/problem/update';

/** Implementation of each declared tool, keyed by its declared name. */
const IMPLEMENTATIONS: Record<string, (context: ToolContext, args: ToolArgs) => Promise<unknown>> = {
    base_create: baseCreate.execute,
    base_list: baseList.execute,
    base_search: baseSearch.execute,
    base_get: baseGet.execute,
    base_update: baseUpdate.execute,
    base_delete: baseDelete.execute,
    node_create: nodeCreate.execute,
    node_update: nodeUpdate.execute,
    node_get: nodeGet.execute,
    node_delete: nodeDelete.execute,
    card_create: cardCreate.execute,
    card_update: cardUpdate.execute,
    card_get: cardGet.execute,
    card_delete: cardDelete.execute,
    semantic_search: semanticSearch.execute,
    problem_list: problemList.execute,
    problem_get: problemGet.execute,
    problem_create: problemCreate.execute,
    problem_update: problemUpdate.execute,
    problem_delete: problemDelete.execute,
    git_status: gitStatus.execute,
    git_commit: gitCommit.execute,
    git_push: gitPush.execute,
    git_pull: gitPull.execute,
    git_config_get: gitConfigGet.execute,
    git_config_set: gitConfigSet.execute,
    node_file_list: fileList.execute,
    node_file_get: fileGet.execute,
    node_file_delete: fileDelete.execute,
    node_file_create: fileCreate.execute,
};

/** Tools whose Base may come from the arguments rather than the calling scope. */
const EXPLICIT_BASE_TOOLS = new Set(['base_get', 'base_update', 'base_delete']);

/**
 * Resolve the Base one call acts on, then run its implementation.
 * @param definition - declared tool.
 * @returns the registry declaration, including the execution rule.
 */
function declaration(definition: ToolDef): ToolDeclaration {
    const run = IMPLEMENTATIONS[definition.name];
    if (!run) throw new Error(`no implementation for declared tool ${definition.name}`);
    const explicitBase = EXPLICIT_BASE_TOOLS.has(definition.name);
    return {
        name: definition.expose,
        description: definition.description,
        inputSchema: definition.inputSchema,
        mutating: isBuiltinMutatingTool(definition.name),
        async execute(context, args) {
            const requested = explicitBase ? Number(args.baseId) : context.baseDocId;
            const baseDocId = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
            if (!baseDocId) throw new Error(explicitBase ? 'baseId is required' : 'This endpoint is not bound to a base.');
            return run({ ...context, baseDocId }, args || {});
        },
    };
}

/**
 * Start this addon: publish the tool registry, then the Base tool set.
 *
 * The registry is read through the service store: a service property read is checked
 * against the reading fiber's inject list, which this addon does not declare because it
 * is the one providing the service.
 * @param ctx - host context.
 */
export async function apply(ctx: Context): Promise<void> {
    await ctx.plugin(ToolService);
    const services = ctx as any;
    const tools = (typeof services.get === 'function' ? services.get('tools') : services.tools) as ToolService | undefined;
    if (!tools) throw new Error('ejunztools: the tool registry did not start');
    tools.register({ source: 'base', tools: BUILTIN_TOOLS_CATALOG.map(declaration) });
}
