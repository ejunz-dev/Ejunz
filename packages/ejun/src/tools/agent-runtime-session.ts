import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/server';

export const inject = ['server'];

const ScheduleCreateSchema = Schema.object({
    prompt: Schema.string().required().description('Reminder content to present when the target becomes due.'),
    after_seconds: Schema.number().step(1).min(1).description('Positive safe-integer delay in seconds.'),
    every_seconds: Schema.number().step(1).min(300).description('Fixed-rate safe-integer interval in seconds, at least 300.'),
    at: Schema.union([
        Schema.string(),
        Schema.object({
            date: Schema.string().required(),
            time: Schema.string().required(),
            time_zone: Schema.string().required(),
        }),
    ]).description('Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.'),
}).description(
    'Create one reminder in the current session. Supply a non-empty prompt and exactly one selector: a positive safe-integer after_seconds delay, at as a strict offset date-time or local date/time object, or safe-integer every_seconds of at least 300. Fixed-rate reminders stay creation-aligned, skip missed occurrences, and batch one latest occurrence per overdue rule. Delivery is session-local: the reminder runs on time only while this session is live and otherwise becomes overdue until the session is resumed.',
);

const ScheduleListSchema = Schema.object({}).description(
    'List every active reminder in the current session in creation order, including its exact id, UTC target, scheduled or overdue state, and session-local delivery mode.',
);

const ScheduleDeleteSchema = Schema.object({
    id: Schema.string().required().description('Exact session-local schedule id.'),
}).description(
    'Delete one active reminder in the current session by the exact id returned by schedule_create or schedule_list. Unknown or already-finished ids return deleted false.',
);

const SessionSearchSchema = Schema.object({
    query: Schema.string().required().description('Literal full-text query over prior session history.'),
    session_ids: Schema.array(Schema.string()).description('Optional session ids to include.'),
    created_at_from: Schema.string().description('Inclusive timezone-qualified ISO 8601 creation-time lower bound.'),
    created_at_to: Schema.string().description('Inclusive timezone-qualified ISO 8601 creation-time upper bound.'),
    parent_session_ids: Schema.array(Schema.string()).description('Optional direct parent session ids.'),
    include_root_sessions: Schema.boolean().description('Include sessions with no parent in the parent filter.'),
    availability: Schema.array(Schema.union(['live', 'persisted'] as const)).description('Require at least one selected source availability.'),
    event_seq_from: Schema.number().step(1).description('Inclusive event sequence lower bound.'),
    event_seq_to: Schema.number().step(1).description('Inclusive event sequence upper bound.'),
    event_time_from: Schema.string().description('Inclusive timezone-qualified ISO 8601 event-time lower bound.'),
    event_time_to: Schema.string().description('Inclusive timezone-qualified ISO 8601 event-time upper bound.'),
    event_types: Schema.array(Schema.string()).description('Event types to include.'),
    event_surfaces: Schema.array(Schema.union(['current', 'shadowed', 'log-only'] as const)).description('Event surfaces to include.'),
}).description(
    'Search prior sessions in the caller workspace and return the strongest matching event from each session.',
);

const SessionEventSearchSchema = Schema.object({
    session_id: Schema.string().description('Target session id. Omit for the current session.'),
    query: Schema.string().required().description('Literal full-text query over the target session.'),
    seq_from: Schema.number().step(1).description('Inclusive event sequence lower bound.'),
    seq_to: Schema.number().step(1).description('Inclusive event sequence upper bound.'),
    time_from: Schema.string().description('Inclusive timezone-qualified ISO 8601 event-time lower bound.'),
    time_to: Schema.string().description('Inclusive timezone-qualified ISO 8601 event-time upper bound.'),
    event_types: Schema.array(Schema.string()).description('Event types to include.'),
    surfaces: Schema.array(Schema.union(['current', 'shadowed', 'log-only'] as const)).description('Event surfaces to include.'),
}).description(
    'Search prior events in one authorized session; the current session excludes the step performing this call.',
);

const SessionTraceSchema = Schema.object({
    session_id: Schema.string().description('Target session id. Omit for the current session.'),
}).description(
    'Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.',
);

const SessionEventTraceSchema = Schema.object({
    session_id: Schema.string().description('Target session id. Omit for the current session.'),
    seq: Schema.number().step(1).required().description('Target event sequence number.'),
}).description(
    'Read every direct replacement and relationship to a cited source event for one event in an authorized session.',
);

const SessionEventReadSchema = Schema.object({
    session_id: Schema.string().description('Target session id. Omit for the current session.'),
    seq: Schema.number().step(1).required().description('Target event sequence number.'),
    before: Schema.number().step(1).description('Number of preceding raw events to summarize. Omit for none.'),
    after: Schema.number().step(1).description('Number of following raw events to summarize. Omit for none.'),
}).description(
    'Read one full unabridged event and optional neighboring raw-event summaries from an authorized session.',
);

const LspSchema = Schema.object({
    operation: Schema.union(['goToDefinition', 'findReferences', 'goToImplementation', 'hover'] as const)
        .required()
        .description('goToDefinition, findReferences, goToImplementation, or hover.'),
    file_path: Schema.string().required().description('The source file to query, relative to the workspace or absolute.'),
    line: Schema.number().step(1).required().description('One-based line of the cursor.'),
    character: Schema.number().step(1).required().description('One-based UTF-16 column of the cursor.'),
}).description(
    'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
);

class ScheduleCreateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'schedule_create' }; }
}
class ScheduleListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'schedule_list' }; }
}
class ScheduleDeleteExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'schedule_delete' }; }
}
class SessionSearchExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'session_search' }; }
}
class SessionEventSearchExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'session_event_search' }; }
}
class SessionTraceExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'session_trace' }; }
}
class SessionEventTraceExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'session_event_trace' }; }
}
class SessionEventReadExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'session_event_read' }; }
}
class LspExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'lsp' }; }
}

export function apply(ctx: Context): void {
    ctx.Tool('agent-runtime', 'schedule_create', ScheduleCreateExecutor, ScheduleCreateSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'schedule_list', ScheduleListExecutor, ScheduleListSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'schedule_delete', ScheduleDeleteExecutor, ScheduleDeleteSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'session_search', SessionSearchExecutor, SessionSearchSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'session_event_search', SessionEventSearchExecutor, SessionEventSearchSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'session_trace', SessionTraceExecutor, SessionTraceSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'session_event_trace', SessionEventTraceExecutor, SessionEventTraceSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'session_event_read', SessionEventReadExecutor, SessionEventReadSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'lsp', LspExecutor, LspSchema, PRIV.USER_PRIV_USER_PROFILE);
}
