import type { RuntimeToolCapability } from '../lib/runtime-tool-catalog';

/** Fixed Agent tool defaults; per-session schemas replace these when configuration differs. */
export const AGENT_RUNTIME_EXTRA_TOOLS: readonly RuntimeToolCapability[] = [
    {
        name: 'web_fetch',
        description: 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'The HTTP(S) URL to fetch.' } },
            required: ['url'],
        },
    },
    {
        name: 'schedule_create',
        description: 'Create one reminder in the current session. Supply a non-empty prompt and exactly one selector: a positive safe-integer after_seconds delay, at as a strict offset date-time or local date/time object, or safe-integer every_seconds of at least 300. Fixed-rate reminders stay creation-aligned, skip missed occurrences, and batch one latest occurrence per overdue rule. Delivery is session-local: the reminder runs on time only while this session is live and otherwise becomes overdue until the session is resumed.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Reminder content to present when the target becomes due.' },
                after_seconds: { type: 'number', description: 'Positive safe-integer delay in seconds.' },
                every_seconds: { type: 'number', description: 'Fixed-rate safe-integer interval in seconds, at least 300.' },
                at: {
                    oneOf: [
                        { type: 'string' },
                        {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                date: { type: 'string' },
                                time: { type: 'string' },
                                time_zone: { type: 'string' },
                            },
                            required: ['date', 'time', 'time_zone'],
                        },
                    ],
                    description: 'Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.',
                },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'schedule_list',
        description: 'List every active reminder in the current session in creation order, including its exact id, UTC target, scheduled or overdue state, and session-local delivery mode.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'schedule_delete',
        description: 'Delete one active reminder in the current session by the exact id returned by schedule_create or schedule_list. Unknown or already-finished ids return deleted false.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Exact session-local schedule id.' } },
            required: ['id'],
        },
    },
    {
        name: 'session_search',
        description: 'Search prior sessions in the caller workspace and return the strongest matching event from each session.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Literal full-text query over prior session history.' },
                session_ids: { type: 'array', description: 'Optional session ids to include.', items: { type: 'string' } },
                created_at_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 creation-time lower bound.' },
                created_at_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 creation-time upper bound.' },
                parent_session_ids: { type: 'array', description: 'Optional direct parent session ids.', items: { type: 'string' } },
                include_root_sessions: { type: 'boolean', description: 'Include sessions with no parent in the parent filter.' },
                availability: {
                    type: 'array', description: 'Require at least one selected source availability.',
                    items: { type: 'string', enum: ['live', 'persisted'] },
                },
                event_seq_from: { type: 'integer', description: 'Inclusive event sequence lower bound.' },
                event_seq_to: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
                event_time_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.' },
                event_time_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.' },
                event_types: { type: 'array', description: 'Event types to include.', items: { type: 'string' } },
                event_surfaces: {
                    type: 'array', description: 'Event surfaces to include.',
                    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'session_event_search',
        description: 'Search prior events in one authorized session; the current session excludes the step performing this call.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
                query: { type: 'string', description: 'Literal full-text query over the target session.' },
                seq_from: { type: 'integer', description: 'Inclusive event sequence lower bound.' },
                seq_to: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
                time_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.' },
                time_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.' },
                event_types: { type: 'array', description: 'Event types to include.', items: { type: 'string' } },
                surfaces: {
                    type: 'array', description: 'Event surfaces to include.',
                    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'session_trace',
        description: 'Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.',
        inputSchema: {
            type: 'object',
            properties: { session_id: { type: 'string', description: 'Target session id. Omit for the current session.' } },
        },
    },
    {
        name: 'session_event_trace',
        description: 'Read every direct replacement and relationship to a cited source event for one event in an authorized session.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
                seq: { type: 'integer', description: 'Target event sequence number.' },
            },
            required: ['seq'],
        },
    },
    {
        name: 'session_event_read',
        description: 'Read one full unabridged event and optional neighboring raw-event summaries from an authorized session.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
                seq: { type: 'integer', description: 'Target event sequence number.' },
                before: { type: 'integer', description: 'Number of preceding raw events to summarize. Omit for none.' },
                after: { type: 'integer', description: 'Number of following raw events to summarize. Omit for none.' },
            },
            required: ['seq'],
        },
    },
    {
        name: 'lsp',
        description: 'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
        inputSchema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string', description: 'goToDefinition, findReferences, goToImplementation, or hover.',
                    enum: ['goToDefinition', 'findReferences', 'goToImplementation', 'hover'],
                },
                file_path: { type: 'string', description: 'The source file to query, relative to the workspace or absolute.' },
                line: { type: 'number', description: 'One-based line of the cursor.' },
                character: { type: 'number', description: 'One-based UTF-16 column of the cursor.' },
            },
            required: ['operation', 'file_path', 'line', 'character'],
        },
    },
    {
        name: 'cordis_inspect_list',
        description: 'List every Cordis Inspect Provider currently known to the Host, including local Host Providers and the latest manifests synchronized from the Client. Each entry includes its platform, purpose, read-only methods, and input/output schemas. Call this Tool before creating or modifying a Package, then select the provider and method for cordis_inspect_query from its result. Do not guess names or treat an Inspect method as a business Service that Plugin code can call.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'cordis_inspect_query',
        description: 'Run a read-only query explicitly declared by an Inspect Provider. platform, provider, and method must come from cordis_inspect_list, and input must satisfy that method\'s schema. Use this Tool before cordis_define to read exact Service methods, Event modes, Builtin signatures, Tool schemas, theme tokens, or live Slot trees and props. Host queries run locally. A Client query waits for the first valid page response and remains pending until a page answers or the Tool is cancelled. This Tool cannot invoke business Service methods or modify the runtime. For Service.listService and Event.listEvents, query without input to navigate the compact signature directory, then query the exact service or event for its structured contract and referenced types. For Slots.listSubTree, query without root to navigate the compact tree, then query the exact root for its complete registration contract and props.',
        inputSchema: {
            type: 'object',
            properties: {
                platform: { type: 'string', description: 'Runtime platform that owns the Provider.', enum: ['host', 'client'] },
                provider: { type: 'string', description: 'Exact Provider ID returned by cordis_inspect_list.' },
                method: { type: 'string', description: 'Exact method name declared by the Provider manifest.' },
                input: { description: 'Optional query input; it must satisfy the method input schema.' },
            },
            required: ['platform', 'provider', 'method'],
        },
    },
    {
        name: 'cordis_inspect_self',
        description: 'Inspect dynamic Cordis objects owned by the current Session at increasing levels of detail. With no IDs, list only Plugin summaries. With pluginId alone, return version pointers, the latest Run, and every Package summary. Only pluginId plus packageId returns that immutable Package\'s Host/Client source and runtime diagnostics. packageId cannot be supplied alone. Query an exact Package before handling @pluginId, repairing an asynchronous failure, or defining an updated version. This Tool is read-only: it neither executes code nor changes version pointers.',
        inputSchema: {
            type: 'object',
            properties: {
                pluginId: { type: 'string', description: 'Stable Plugin ID returned by cordis_define or injected by @pluginId; omit it to list every current Plugin.' },
                packageId: { type: 'string', description: 'Exact immutable Package ID owned by pluginId; when specified, source and diagnostics are returned.' },
            },
        },
    },
    {
        name: 'cordis_define',
        description: 'Define an immutable Cordis Package. For a new Plugin, use kind:"new" and provide only a semantic prefix of 3–6 lowercase English letters; the Host returns the final pluginId and packageId. To modify an existing Plugin, use kind:"existing" with its exact pluginId to append a Package without overwriting older versions. Provide at least one of code.host and code.client. Each value is a plain JavaScript function body that returns a Cordis Plugin; no TypeScript, JSX, or import transformation occurs. Query Inspect before depending on a Service, Event, Builtin, Slot, or token. Define only validates parameters and syntax and records source: it does not request approval, execute apply, or change currentPackageId. On success, call cordis_run with the returned IDs.',
        inputSchema: {
            type: 'object',
            properties: {
                plugin: {
                    oneOf: [
                        {
                            type: 'object', additionalProperties: false,
                            properties: {
                                kind: { type: 'string', const: 'new' },
                                idPrefix: { type: 'string', description: 'Suggested semantic prefix of 3–6 lowercase English letters; the Host adds a unique numeric suffix.' },
                            },
                            required: ['kind', 'idPrefix'],
                        },
                        {
                            type: 'object', additionalProperties: false,
                            properties: {
                                kind: { type: 'string', const: 'existing' },
                                pluginId: { type: 'string', description: 'Exact ID of an existing Plugin; the new Package is appended to that instance.' },
                            },
                            required: ['kind', 'pluginId'],
                        },
                    ],
                },
                name: { type: 'string', description: 'Short, readable Package name.' },
                purpose: { type: 'string', description: 'One-sentence, user-facing description of the Package purpose.' },
                code: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        host: { type: 'string', description: 'Plain JavaScript function body that returns the Host-half Cordis Plugin.' },
                        client: { type: 'string', description: 'Plain JavaScript function body that returns the browser Client-half Cordis Plugin.' },
                    },
                },
            },
            required: ['plugin', 'name', 'purpose', 'code'],
        },
    },
    {
        name: 'cordis_run',
        description: 'Activate one exact Package of a dynamic Plugin. Use mode:"run" for the first activation, restarting currentPackageId, or rollback. When current exists, use mode:"update" to switch to a different Package, even if the Plugin is currently stopped. An unauthorized Client Package creates an approval request and returns awaiting-approval; an authorized Package returns starting and continues asynchronously in the browser. Neither result waits for the final outcome inside the Tool. currentPackageId changes only after complete success; on failure, the old current and target next remain. Asynchronous success, rejection, or technical failure is reported through state and steering. After a technical failure, read diagnostics with cordis_inspect_self, correct the same Plugin, and retry autonomously. Do not request approval again after the user rejects it.',
        inputSchema: {
            type: 'object',
            properties: {
                pluginId: { type: 'string', description: 'Stable Plugin ID returned by cordis_define.' },
                packageId: { type: 'string', description: 'Exact immutable Package ID to activate under that Plugin.' },
                mode: { type: 'string', description: 'Use run for the first activation, restarting current, or rollback; use update to switch from current to a different Package.', enum: ['run', 'update'] },
            },
            required: ['pluginId', 'packageId', 'mode'],
        },
    },
    {
        name: 'cordis_stop',
        description: 'Stop the current Run of a dynamic Plugin and cancel unfinished approval or activation requests. Retain the Plugin, every immutable Package, grants, currentPackageId, and nextPackageId so it can later run or update directly. Stopping an already stopped Plugin succeeds idempotently. Use this Tool to disable effects temporarily; use cordis_undefine for permanent removal.',
        inputSchema: {
            type: 'object',
            properties: { pluginId: { type: 'string', description: 'Stable dynamic Plugin ID to stop.' } },
            required: ['pluginId'],
        },
    },
    {
        name: 'cordis_undefine',
        description: 'Permanently remove a dynamic Plugin owned by the current Session. If it is running or awaiting approval, first stop it and cancel the request, then delete every Package, grant, and version pointer. After this returns, its pluginId, packageIds, @ reference, and Package business views are invalid; historical cards retain only a "Plugin removed" record. Do not call this Tool when versions must remain available for restart or rollback; use cordis_stop instead.',
        inputSchema: {
            type: 'object',
            properties: { pluginId: { type: 'string', description: 'Stable dynamic Plugin ID to remove permanently.' } },
            required: ['pluginId'],
        },
    },
    {
        name: 'send_message',
        description: 'Send a message to a background subagent by its subagent id, continuing the same conversation. It becomes the subagent\'s next turn: if it is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. This call returns no answer from the subagent — only confirmation that the message was delivered — so use it to give it more work. A failure means the message was NOT delivered.',
        inputSchema: {
            type: 'object',
            properties: {
                subagent_id: { type: 'string', description: 'The subagent id returned when the background subagent was started.' },
                message: { type: 'string', description: 'The message to deliver to the subagent.' },
            },
            required: ['subagent_id', 'message'],
        },
    },
    {
        name: 'interrupt_agent',
        description: 'Request cancellation of a background agent\'s current turn by its agent id. The target may be your direct child or a deeper agent created under you. Only the current turn stops: messages already queued for the agent stay parked until a later send_message, agents it started keep running, and the agent itself stays available for follow-ups. This call returns as soon as the stop request is accepted, so the target may keep running briefly; interrupting an agent that already finished is an accepted no-op.',
        inputSchema: {
            type: 'object',
            properties: { agent_id: { type: 'string', description: 'The agent id of the running agent to interrupt.' } },
            required: ['agent_id'],
        },
    },
    {
        name: 'list_agents',
        description: 'List your continuable background subagents by durable id and label. Use it to recall which ones you started, not to poll for completion — you are told when one finishes. Status comes from the live registry: running means the agent is working right now, idle means it is loaded but between turns (it may be waiting on agents it started), and ready means it exists only in storage — resumable, not terminal, and not a result waiting to be collected; a send_message starts a new turn on the same conversation, and a direct child remains a send_message candidate in every status. The snapshot is not a delivery promise — send_message performs the authoritative check and may still fail. Children that could not be read are reported as diagnostics instead of being silently dropped. Scope descendants walks the whole tree below you in stable pre-order, annotating each entry with its durable direct-parent session id and depth. You may use send_message only for depth-1 entries; deeper entries are candidates for interrupt_agent only.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: { type: 'string', description: 'children (default) lists direct children only; descendants walks the complete tree below you.', enum: ['children', 'descendants'] },
            },
        },
    },
    {
        name: 'subagent',
        description: 'Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation\'s context. The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation. This call waits for the result by default. Set run_in_background: true to return a job id; collect with job_output and stop with job_kill.',
        inputSchema: {
            type: 'object',
            properties: {
                description: { type: 'string', description: 'A short (3-5 word) description of the delegated task, for display.' },
                prompt: { type: 'string', description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
                run_in_background: { type: 'boolean', description: 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.' },
            },
            required: ['description', 'prompt'],
        },
    },
    {
        name: 'subagent_fork',
        description: 'Delegate a self-contained task to a subagent using the fork backend. This shipped alias is configured separately; its exact schema is selected from the current Agent scope.',
        inputSchema: {
            type: 'object',
            properties: {
                description: { type: 'string' },
                prompt: { type: 'string' },
                run_in_background: { type: 'boolean' },
            },
            required: ['description', 'prompt'],
        },
    },
    {
        name: 'report',
        description: 'Report selected content to the agent that started you. Call this once before you finish, with a self-contained final result, and earlier for progress or findings that change what that agent does next. That agent shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so finishing your work is not itself a result. Reporting does not end your turn or finish your work, and only your direct parent receives it. A failed call may still have arrived, so do not blindly repeat it.',
        inputSchema: {
            type: 'object',
            properties: { output: { type: 'string', description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.' } },
            required: ['output'],
        },
    },
    {
        name: 'structured_output',
        description: 'Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool\'s parameter schema exactly.',
        inputSchema: { type: 'object', additionalProperties: true },
    },
    {
        name: 'ralph',
        description: 'Run a foreground fresh-agent Ralph loop toward one immutable objective. Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round opens a new child with no parent conversation or prior child session; the shared workspace is long-term memory, and only a bounded structured report crosses rounds. The call returns when a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work belongs to goal tools.',
        inputSchema: {
            type: 'object',
            properties: {
                objective: { type: 'string', description: 'The immutable completion objective for every fresh Ralph round.' },
                maxRounds: { type: 'number', description: 'Optional positive safe-integer round cap, bounded by the deployment ceiling.' },
            },
            required: ['objective'],
        },
    },
    {
        name: 'workflow',
        description: 'Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.',
        inputSchema: {
            type: 'object',
            properties: {
                script: { type: 'string', description: 'The plain-JS workflow script body (top-level await allowed; NO export const meta statement; end with return <json-value>).' },
                meta: {
                    type: 'object', additionalProperties: true,
                    properties: {
                        name: { type: 'string', description: 'Short kebab-case workflow name.' },
                        description: { type: 'string', description: 'One-line description of what the workflow does.' },
                        whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
                        phases: {
                            type: 'array', description: 'Optional phase declarations matched by phase() calls.',
                            items: {
                                type: 'object', additionalProperties: true,
                                properties: {
                                    title: { type: 'string', description: 'The phase title phase() calls match by exact string.' },
                                    detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                                    provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                                    model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
                                },
                                required: ['title'],
                            },
                        },
                        args: { type: 'object', description: 'Optional JSON input exposed to the script as the args global.', additionalProperties: true },
                    },
                    required: ['name', 'description'],
                },
            },
            required: ['script', 'meta'],
        },
    },
] satisfies readonly RuntimeToolCapability[];
