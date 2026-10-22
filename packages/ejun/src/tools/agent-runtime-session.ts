import type { Context } from 'ejun/src/context';
import type {} from '../service/server';
import { PRIV } from 'ejun/src/model/builtin';
import { ADDON_ID, SESSION_TOOL, runtimeToolExecutor } from './agent-runtime';

export const inject = ['server'];

const ScheduleCreateDescription = [
    "Create one reminder in the current session. Supply a non-empty prompt and exactly one selector: a ",
    "positive safe-integer after_seconds delay, at as a strict offset date-time or local date/time ",
    "object, or safe-integer every_seconds of at least 300. Fixed-rate reminders stay creation-aligned, ",
    "skip missed occurrences, and batch one latest occurrence per overdue rule. Delivery is ",
    "session-local: the reminder runs on time only while this session is live and otherwise becomes ",
    "overdue until the session is resumed.",
].join('');
const ScheduleCreateInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Reminder content to present when the target becomes due.'
    },
    after_seconds: {
      type: 'number',
      description: 'Positive safe-integer delay in seconds.'
    },
    every_seconds: {
      type: 'number',
      description: 'Fixed-rate safe-integer interval in seconds, at least 300.'
    },
    at: {
      oneOf: [
        {
          type: 'string'
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            date: {
              type: 'string'
            },
            time: {
              type: 'string'
            },
            time_zone: {
              type: 'string'
            }
          },
          required: [
            'date',
            'time',
            'time_zone'
          ]
        }
      ],
      description: 'Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.'
    }
  },
  required: [
    'prompt'
  ]
};

const ScheduleListDescription = [
    "List every active reminder in the current session in creation order, including its exact id, UTC ",
    "target, scheduled or overdue state, and session-local delivery mode.",
].join('');
const ScheduleListInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {}
};

const ScheduleDeleteDescription = [
    "Delete one active reminder in the current session by the exact id returned by schedule_create or ",
    "schedule_list. Unknown or already-finished ids return deleted false.",
].join('');
const ScheduleDeleteInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Exact session-local schedule id.'
    }
  },
  required: [
    'id'
  ]
};

const SessionSearchDescription = 'Search prior sessions in the caller workspace and return the strongest matching event from each session.';
const SessionSearchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Literal full-text query over prior session history.'
    },
    session_ids: {
      type: 'array',
      description: 'Optional session ids to include.',
      items: {
        type: 'string'
      }
    },
    created_at_from: {
      type: 'string',
      description: 'Inclusive timezone-qualified ISO 8601 creation-time lower bound.'
    },
    created_at_to: {
      type: 'string',
      description: 'Inclusive timezone-qualified ISO 8601 creation-time upper bound.'
    },
    parent_session_ids: {
      type: 'array',
      description: 'Optional direct parent session ids.',
      items: {
        type: 'string'
      }
    },
    include_root_sessions: {
      type: 'boolean',
      description: 'Include sessions with no parent in the parent filter.'
    },
    availability: {
      type: 'array',
      description: 'Require at least one selected source availability.',
      items: {
        type: 'string',
        enum: [
          'live',
          'persisted'
        ]
      }
    },
    event_seq_from: {
      type: 'integer',
      description: 'Inclusive event sequence lower bound.'
    },
    event_seq_to: {
      type: 'integer',
      description: 'Inclusive event sequence upper bound.'
    },
    event_time_from: {
      type: 'string',
      description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.'
    },
    event_time_to: {
      type: 'string',
      description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.'
    },
    event_types: {
      type: 'array',
      description: 'Event types to include.',
      items: {
        type: 'string'
      }
    },
    event_surfaces: {
      type: 'array',
      description: 'Event surfaces to include.',
      items: {
        type: 'string',
        enum: [
          'current',
          'shadowed',
          'log-only'
        ]
      }
    }
  },
  required: [
    'query'
  ]
};

const SessionEventSearchDescription = [
    "Search prior events in one authorized session; the current session excludes the step performing ",
    "this call.",
].join('');
const SessionEventSearchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    session_id: {
      type: 'string',
      description: 'Target session id. Omit for the current session.'
    },
    query: {
      type: 'string',
      description: 'Literal full-text query over the target session.'
    },
    seq_from: {
      type: 'integer',
      description: 'Inclusive event sequence lower bound.'
    },
    seq_to: {
      type: 'integer',
      description: 'Inclusive event sequence upper bound.'
    },
    time_from: {
      type: 'string',
      description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.'
    },
    time_to: {
      type: 'string',
      description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.'
    },
    event_types: {
      type: 'array',
      description: 'Event types to include.',
      items: {
        type: 'string'
      }
    },
    surfaces: {
      type: 'array',
      description: 'Event surfaces to include.',
      items: {
        type: 'string',
        enum: [
          'current',
          'shadowed',
          'log-only'
        ]
      }
    }
  },
  required: [
    'query'
  ]
};

const SessionTraceDescription = [
    "Read the authorized session lineage around one session, including complete visible ancestor and ",
    "descendant relationships.",
].join('');
const SessionTraceInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    session_id: {
      type: 'string',
      description: 'Target session id. Omit for the current session.'
    }
  }
};

const SessionEventTraceDescription = [
    "Read every direct replacement and relationship to a cited source event for one event in an ",
    "authorized session.",
].join('');
const SessionEventTraceInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    session_id: {
      type: 'string',
      description: 'Target session id. Omit for the current session.'
    },
    seq: {
      type: 'integer',
      description: 'Target event sequence number.'
    }
  },
  required: [
    'seq'
  ]
};

const SessionEventReadDescription = [
    "Read one full unabridged event and optional neighboring raw-event summaries from an authorized ",
    "session.",
].join('');
const SessionEventReadInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    session_id: {
      type: 'string',
      description: 'Target session id. Omit for the current session.'
    },
    seq: {
      type: 'integer',
      description: 'Target event sequence number.'
    },
    before: {
      type: 'integer',
      description: 'Number of preceding raw events to summarize. Omit for none.'
    },
    after: {
      type: 'integer',
      description: 'Number of following raw events to summarize. Omit for none.'
    }
  },
  required: [
    'seq'
  ]
};

const LspDescription = [
    "Query a language server for precise code navigation. operation is one of goToDefinition, ",
    "findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor ",
    "coordinates. findReferences includes the declaration.",
].join('');
const LspInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      description: 'goToDefinition, findReferences, goToImplementation, or hover.',
      enum: [
        'goToDefinition',
        'findReferences',
        'goToImplementation',
        'hover'
      ]
    },
    file_path: {
      type: 'string',
      description: 'The source file to query, relative to the workspace or absolute.'
    },
    line: {
      type: 'number',
      description: 'One-based line of the cursor.'
    },
    character: {
      type: 'number',
      description: 'One-based UTF-16 column of the cursor.'
    }
  },
  required: [
    'operation',
    'file_path',
    'line',
    'character'
  ]
};

export function apply(ctx: Context): void {
    ctx.Tool(ADDON_ID, 'schedule_create', runtimeToolExecutor('schedule_create'), {
        ...SESSION_TOOL,
        description: ScheduleCreateDescription,
        inputSchema: ScheduleCreateInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'schedule_list', runtimeToolExecutor('schedule_list'), {
        ...SESSION_TOOL,
        description: ScheduleListDescription,
        inputSchema: ScheduleListInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'schedule_delete', runtimeToolExecutor('schedule_delete'), {
        ...SESSION_TOOL,
        description: ScheduleDeleteDescription,
        inputSchema: ScheduleDeleteInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'session_search', runtimeToolExecutor('session_search'), {
        ...SESSION_TOOL,
        description: SessionSearchDescription,
        inputSchema: SessionSearchInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'session_event_search', runtimeToolExecutor('session_event_search'), {
        ...SESSION_TOOL,
        description: SessionEventSearchDescription,
        inputSchema: SessionEventSearchInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'session_trace', runtimeToolExecutor('session_trace'), {
        ...SESSION_TOOL,
        description: SessionTraceDescription,
        inputSchema: SessionTraceInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'session_event_trace', runtimeToolExecutor('session_event_trace'), {
        ...SESSION_TOOL,
        description: SessionEventTraceDescription,
        inputSchema: SessionEventTraceInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'session_event_read', runtimeToolExecutor('session_event_read'), {
        ...SESSION_TOOL,
        description: SessionEventReadDescription,
        inputSchema: SessionEventReadInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'lsp', runtimeToolExecutor('lsp'), {
        ...SESSION_TOOL,
        description: LspDescription,
        inputSchema: LspInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
}
