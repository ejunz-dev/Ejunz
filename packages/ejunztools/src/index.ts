import type { Context } from 'ejun/src/context';
import ToolService from './registry';
import type { ToolDeclaration } from './registry';
import {
    BUILTIN_TOOLS_CATALOG,
    SCHEDULE_TOOLS_CATALOG,
    isBuiltinMutatingTool,
    isScheduleMutatingTool,
    type ScheduleToolDef,
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
import * as embeddingStatus from './base/embedding/status';
import * as embeddingReindex from './base/embedding/reindex';
import * as cardCreate from './base/card/create';
import * as cardCreateMany from './base/card/create-many';
import * as cardDelete from './base/card/delete';
import * as cardDeleteMany from './base/card/delete-many';
import * as cardGet from './base/card/get';
import * as cardGetMany from './base/card/get-many';
import * as cardUpdate from './base/card/update';
import * as cardUpdateMany from './base/card/update-many';
import * as fileCreate from './base/file/create';
import * as fileCreateMany from './base/file/create-many';
import * as fileDelete from './base/file/delete';
import * as fileDeleteMany from './base/file/delete-many';
import * as fileGet from './base/file/get';
import * as fileGetMany from './base/file/get-many';
import * as fileList from './base/file/list';
import * as fileListMany from './base/file/list-many';
import * as gitCommit from './base/git/commit';
import * as gitConfigGet from './base/git/config-get';
import * as gitConfigSet from './base/git/config-set';
import * as gitPull from './base/git/pull';
import * as gitPush from './base/git/push';
import * as gitStatus from './base/git/status';
import * as nodeCreate from './base/node/create';
import * as nodeCreateMany from './base/node/create-many';
import * as nodeDelete from './base/node/delete';
import * as nodeDeleteMany from './base/node/delete-many';
import * as nodeGet from './base/node/get';
import * as nodeGetMany from './base/node/get-many';
import * as nodeUpdate from './base/node/update';
import * as nodeUpdateMany from './base/node/update-many';
import * as problemCreate from './base/problem/create';
import * as problemCreateMany from './base/problem/create-many';
import * as problemDelete from './base/problem/delete';
import * as problemDeleteMany from './base/problem/delete-many';
import * as problemGet from './base/problem/get';
import * as problemGetMany from './base/problem/get-many';
import * as problemList from './base/problem/list';
import * as problemUpdate from './base/problem/update';
import * as problemUpdateMany from './base/problem/update-many';
import * as scheduleCreate from './schedule/create';
import * as scheduleDelete from './schedule/delete';
import * as scheduleGet from './schedule/get';
import * as scheduleHistory from './schedule/history';
import * as scheduleList from './schedule/list';
import * as schedulePause from './schedule/pause';
import * as scheduleResume from './schedule/resume';
import * as scheduleUpdate from './schedule/update';

const IMPLEMENTATIONS: Record<string, (context: ToolContext, args: ToolArgs) => Promise<unknown>> = {
    base_create: baseCreate.execute,
    base_list: baseList.execute,
    base_search: baseSearch.execute,
    base_get: baseGet.execute,
    base_update: baseUpdate.execute,
    base_delete: baseDelete.execute,
    node_create: nodeCreate.execute,
    node_create_many: nodeCreateMany.execute,
    node_update: nodeUpdate.execute,
    node_update_many: nodeUpdateMany.execute,
    node_get: nodeGet.execute,
    node_get_many: nodeGetMany.execute,
    node_delete: nodeDelete.execute,
    node_delete_many: nodeDeleteMany.execute,
    card_create: cardCreate.execute,
    card_create_many: cardCreateMany.execute,
    card_update: cardUpdate.execute,
    card_update_many: cardUpdateMany.execute,
    card_get: cardGet.execute,
    card_get_many: cardGetMany.execute,
    card_delete: cardDelete.execute,
    card_delete_many: cardDeleteMany.execute,
    semantic_search: semanticSearch.execute,
    embedding_status: embeddingStatus.execute,
    embedding_reindex: embeddingReindex.execute,
    problem_list: problemList.execute,
    problem_get: problemGet.execute,
    problem_get_many: problemGetMany.execute,
    problem_create: problemCreate.execute,
    problem_create_many: problemCreateMany.execute,
    problem_update: problemUpdate.execute,
    problem_update_many: problemUpdateMany.execute,
    problem_delete: problemDelete.execute,
    problem_delete_many: problemDeleteMany.execute,
    git_status: gitStatus.execute,
    git_commit: gitCommit.execute,
    git_push: gitPush.execute,
    git_pull: gitPull.execute,
    git_config_get: gitConfigGet.execute,
    git_config_set: gitConfigSet.execute,
    node_file_list: fileList.execute,
    node_file_list_many: fileListMany.execute,
    node_file_get: fileGet.execute,
    node_file_get_many: fileGetMany.execute,
    node_file_delete: fileDelete.execute,
    node_file_delete_many: fileDeleteMany.execute,
    node_file_create: fileCreate.execute,
    node_file_create_many: fileCreateMany.execute,
};

const SCHEDULE_IMPLEMENTATIONS: Record<string, (args: ToolArgs, context: ToolContext) => Promise<unknown>> = {
    schedule_create: scheduleCreate.execute,
    schedule_get: scheduleGet.execute,
    schedule_list: scheduleList.execute,
    schedule_update: scheduleUpdate.execute,
    schedule_delete: scheduleDelete.execute,
    schedule_pause: schedulePause.execute,
    schedule_resume: scheduleResume.execute,
    schedule_history: scheduleHistory.execute,
};

const EXPLICIT_BASE_TOOLS = new Set(['base_get', 'base_update', 'base_delete']);

const OPTIONAL_BASE_TOOLS = new Set(['embedding_status', 'embedding_reindex']);

function declaration(definition: ToolDef): ToolDeclaration {
    const run = IMPLEMENTATIONS[definition.name];
    if (!run) throw new Error(`no implementation for declared tool ${definition.name}`);
    const explicitBase = EXPLICIT_BASE_TOOLS.has(definition.name);
    const optionalBase = OPTIONAL_BASE_TOOLS.has(definition.name);
    return {
        name: definition.expose,
        description: definition.description,
        inputSchema: definition.inputSchema,
        mutating: isBuiltinMutatingTool(definition.name),
        async execute(context, args) {
            const namedBaseId = Number(args.baseId);
            const requested = explicitBase ? namedBaseId
                : optionalBase && Number.isSafeInteger(namedBaseId) && namedBaseId > 0 ? namedBaseId
                    : context.baseDocId;
            const baseDocId = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
            if (!baseDocId) throw new Error(explicitBase ? 'baseId is required' : 'This endpoint is not bound to a base.');
            return run({ ...context, baseDocId }, args || {});
        },
    };
}

function scheduleDeclaration(definition: ScheduleToolDef): ToolDeclaration {
    const run = SCHEDULE_IMPLEMENTATIONS[definition.name];
    if (!run) throw new Error(`no implementation for declared schedule tool ${definition.name}`);
    return {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        mutating: isScheduleMutatingTool(definition.name),
        execute: (context, args) => run(args || {}, context),
    };
}

export async function apply(ctx: Context): Promise<void> {
    await ctx.plugin(ToolService);
    const services = ctx as any;
    const tools = (typeof services.get === 'function' ? services.get('tools') : services.tools) as ToolService | undefined;
    if (!tools) throw new Error('ejunztools: the tool registry did not start');
    tools.register({ source: 'base', tools: BUILTIN_TOOLS_CATALOG.map(declaration) });
    tools.register({ source: 'schedule', tools: SCHEDULE_TOOLS_CATALOG.map(scheduleDeclaration) });
}
