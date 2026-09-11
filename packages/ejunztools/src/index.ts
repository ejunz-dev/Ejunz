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
