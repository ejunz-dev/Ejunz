import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import { delegateAgentRuntimeTool } from '../lib/agent-runtime-tool';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/server';

export const inject = ['server'];

const CordisInspectListSchema = Schema.object({}).description(
    'List every Cordis Inspect Provider currently known to the Host, including local Host Providers and the latest manifests synchronized from the Client. Each entry includes its platform, purpose, read-only methods, and input/output schemas. Call this Tool before creating or modifying a Package, then select the provider and method for cordis_inspect_query from its result. Do not guess names or treat an Inspect method as a business Service that Plugin code can call.',
);

const CordisInspectQuerySchema = Schema.object({
    platform: Schema.union(['host', 'client'] as const).required().description('Runtime platform that owns the Provider.'),
    provider: Schema.string().required().description('Exact Provider ID returned by cordis_inspect_list.'),
    method: Schema.string().required().description('Exact method name declared by the Provider manifest.'),
    input: Schema.any().description('Optional query input; it must satisfy the method input schema.'),
}).description(
    'Run a read-only query explicitly declared by an Inspect Provider. platform, provider, and method must come from cordis_inspect_list, and input must satisfy that method\'s schema. Use this Tool before cordis_define to read exact Service methods, Event modes, Builtin signatures, Tool schemas, theme tokens, or live Slot trees and props. Host queries run locally. A Client query waits for the first valid page response and remains pending until a page answers or the Tool is cancelled. This Tool cannot invoke business Service methods or modify the runtime. For Service.listService and Event.listEvents, query without input to navigate the compact signature directory, then query the exact service or event for its structured contract and referenced types. For Slots.listSubTree, query without root to navigate the compact tree, then query the exact root for its complete registration contract and props.',
);

const CordisInspectSelfSchema = Schema.object({
    pluginId: Schema.string().description('Stable Plugin ID returned by cordis_define or injected by @pluginId; omit it to list every current Plugin.'),
    packageId: Schema.string().description('Exact immutable Package ID owned by pluginId; when specified, source and diagnostics are returned.'),
}).description(
    'Inspect dynamic Cordis objects owned by the current Session at increasing levels of detail. With no IDs, list only Plugin summaries. With pluginId alone, return version pointers, the latest Run, and every Package summary. Only pluginId plus packageId returns that immutable Package\'s Host/Client source and runtime diagnostics. packageId cannot be supplied alone. Query an exact Package before handling @pluginId, repairing an asynchronous failure, or defining an updated version. This Tool is read-only: it neither executes code nor changes version pointers.',
);

const CordisDefineSchema = Schema.object({
    plugin: Schema.union([
        Schema.object({
            kind: Schema.const('new').required(),
            idPrefix: Schema.string().required().description('Suggested semantic prefix of 3–6 lowercase English letters; the Host adds a unique numeric suffix.'),
        }),
        Schema.object({
            kind: Schema.const('existing').required(),
            pluginId: Schema.string().required().description('Exact ID of an existing Plugin; the new Package is appended to that instance.'),
        }),
    ]).required(),
    name: Schema.string().required().description('Short, readable Package name.'),
    purpose: Schema.string().required().description('One-sentence, user-facing description of the Package purpose.'),
    code: Schema.object({
        host: Schema.string().description('Plain JavaScript function body that returns the Host-half Cordis Plugin.'),
        client: Schema.string().description('Plain JavaScript function body that returns the browser Client-half Cordis Plugin.'),
    }).required(),
}).description(
    'Define an immutable Cordis Package. For a new Plugin, use kind:"new" and provide only a semantic prefix of 3–6 lowercase English letters; the Host returns the final pluginId and packageId. To modify an existing Plugin, use kind:"existing" with its exact pluginId to append a Package without overwriting older versions. Provide at least one of code.host and code.client. Each value is a plain JavaScript function body that returns a Cordis Plugin; no TypeScript, JSX, or import transformation occurs. Query Inspect before depending on a Service, Event, Builtin, Slot, or token. Define only validates parameters and syntax and records source: it does not request approval, execute apply, or change currentPackageId. On success, call cordis_run with the returned IDs.',
);

const CordisRunSchema = Schema.object({
    pluginId: Schema.string().required().description('Stable Plugin ID returned by cordis_define.'),
    packageId: Schema.string().required().description('Exact immutable Package ID to activate under that Plugin.'),
    mode: Schema.union(['run', 'update'] as const).required().description('Use run for the first activation, restarting current, or rollback; use update to switch from current to a different Package.'),
}).description(
    'Activate one exact Package of a dynamic Plugin. Use mode:"run" for the first activation, restarting currentPackageId, or rollback. When current exists, use mode:"update" to switch to a different Package, even if the Plugin is currently stopped. An unauthorized Client Package creates an approval request and returns awaiting-approval; an authorized Package returns starting and continues asynchronously in the browser. Neither result waits for the final outcome inside the Tool. currentPackageId changes only after complete success; on failure, the old current and target next remain. Asynchronous success, rejection, or technical failure is reported through state and steering. After a technical failure, read diagnostics with cordis_inspect_self, correct the same Plugin, and retry autonomously. Do not request approval again after the user rejects it.',
);

const CordisStopSchema = Schema.object({
    pluginId: Schema.string().required().description('Stable dynamic Plugin ID to stop.'),
}).description(
    'Stop the current Run of a dynamic Plugin and cancel unfinished approval or activation requests. Retain the Plugin, every immutable Package, grants, currentPackageId, and nextPackageId so it can later run or update directly. Stopping an already stopped Plugin succeeds idempotently. Use this Tool to disable effects temporarily; use cordis_undefine for permanent removal.',
);

const CordisUndefineSchema = Schema.object({
    pluginId: Schema.string().required().description('Stable dynamic Plugin ID to remove permanently.'),
}).description(
    'Permanently remove a dynamic Plugin owned by the current Session. If it is running or awaiting approval, first stop it and cancel the request, then delete every Package, grant, and version pointer. After this returns, its pluginId, packageIds, @ reference, and Package business views are invalid; historical cards retain only a "Plugin removed" record. Do not call this Tool when versions must remain available for restart or rollback; use cordis_stop instead.',
);

class CordisInspectListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_inspect_list'); }
}
class CordisInspectQueryExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_inspect_query'); }
}
class CordisInspectSelfExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_inspect_self'); }
}
class CordisDefineExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_define'); }
}
class CordisRunExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_run'); }
}
class CordisStopExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_stop'); }
}
class CordisUndefineExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('cordis_undefine'); }
}

export function apply(ctx: Context): void {
    ctx.Tool('agent-runtime', 'cordis_inspect_list', CordisInspectListExecutor, CordisInspectListSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'cordis_inspect_query', CordisInspectQueryExecutor, CordisInspectQuerySchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'cordis_inspect_self', CordisInspectSelfExecutor, CordisInspectSelfSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'cordis_define', CordisDefineExecutor, CordisDefineSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'cordis_run', CordisRunExecutor, CordisRunSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'cordis_stop', CordisStopExecutor, CordisStopSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'cordis_undefine', CordisUndefineExecutor, CordisUndefineSchema, PRIV.USER_PRIV_USER_PROFILE);
}
