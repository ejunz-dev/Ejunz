import type { Context } from 'ejun/src/context';
import type {} from '../service/server';
import { PRIV } from 'ejun/src/model/builtin';
import { ADDON_ID, SESSION_TOOL, runtimeToolExecutor } from './agent-runtime';

export const inject = ['server'];

const CordisInspectListDescription = [
    "List every Cordis Inspect Provider currently known to the Host, including local Host Providers and ",
    "the latest manifests synchronized from the Client. Each entry includes its platform, purpose, ",
    "read-only methods, and input/output schemas. Call this Tool before creating or modifying a Package, ",
    "then select the provider and method for cordis_inspect_query from its result. Do not guess names or ",
    "treat an Inspect method as a business Service that Plugin code can call.",
].join('');
const CordisInspectListInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {}
};

const CordisInspectQueryDescription = [
    "Run a read-only query explicitly declared by an Inspect Provider. platform, provider, and method ",
    "must come from cordis_inspect_list, and input must satisfy that method's schema. Use this Tool ",
    "before cordis_define to read exact Service methods, Event modes, Builtin signatures, Tool schemas, ",
    "theme tokens, or live Slot trees and props. Host queries run locally. A Client query waits for the ",
    "first valid page response and remains pending until a page answers or the Tool is cancelled. This ",
    "Tool cannot invoke business Service methods or modify the runtime. For Service.listService and ",
    "Event.listEvents, query without input to navigate the compact signature directory, then query the ",
    "exact service or event for its structured contract and referenced types. For Slots.listSubTree, ",
    "query without root to navigate the compact tree, then query the exact root for its complete ",
    "registration contract and props.",
].join('');
const CordisInspectQueryInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    platform: {
      type: 'string',
      description: 'Runtime platform that owns the Provider.',
      enum: [
        'host',
        'client'
      ]
    },
    provider: {
      type: 'string',
      description: 'Exact Provider ID returned by cordis_inspect_list.'
    },
    method: {
      type: 'string',
      description: 'Exact method name declared by the Provider manifest.'
    },
    input: {
      description: 'Optional query input; it must satisfy the method input schema.'
    }
  },
  required: [
    'platform',
    'provider',
    'method'
  ]
};

const CordisInspectSelfDescription = [
    "Inspect dynamic Cordis objects owned by the current Session at increasing levels of detail. With no ",
    "IDs, list only Plugin summaries. With pluginId alone, return version pointers, the latest Run, and ",
    "every Package summary. Only pluginId plus packageId returns that immutable Package's Host/Client ",
    "source and runtime diagnostics. packageId cannot be supplied alone. Query an exact Package before ",
    "handling @pluginId, repairing an asynchronous failure, or defining an updated version. This Tool is ",
    "read-only: it neither executes code nor changes version pointers.",
].join('');
const CordisInspectSelfInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    pluginId: {
      type: 'string',
      description: 'Stable Plugin ID returned by cordis_define or injected by @pluginId; omit it to list every current Plugin.'
    },
    packageId: {
      type: 'string',
      description: 'Exact immutable Package ID owned by pluginId; when specified, source and diagnostics are returned.'
    }
  }
};

const CordisDefineDescription = [
    "Define an immutable Cordis Package. For a new Plugin, use kind:\"new\" and provide only a semantic ",
    "prefix of 3–6 lowercase English letters; the Host returns the final pluginId and packageId. To ",
    "modify an existing Plugin, use kind:\"existing\" with its exact pluginId to append a Package without ",
    "overwriting older versions. Provide at least one of code.host and code.client. Each value is a ",
    "plain JavaScript function body that returns a Cordis Plugin; no TypeScript, JSX, or import ",
    "transformation occurs. Query Inspect before depending on a Service, Event, Builtin, Slot, or token. ",
    "Define only validates parameters and syntax and records source: it does not request approval, ",
    "execute apply, or change currentPackageId. On success, call cordis_run with the returned IDs.",
].join('');
const CordisDefineInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    plugin: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              const: 'new'
            },
            idPrefix: {
              type: 'string',
              description: 'Suggested semantic prefix of 3–6 lowercase English letters; the Host adds a unique numeric suffix.'
            }
          },
          required: [
            'kind',
            'idPrefix'
          ]
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              const: 'existing'
            },
            pluginId: {
              type: 'string',
              description: 'Exact ID of an existing Plugin; the new Package is appended to that instance.'
            }
          },
          required: [
            'kind',
            'pluginId'
          ]
        }
      ]
    },
    name: {
      type: 'string',
      description: 'Short, readable Package name.'
    },
    purpose: {
      type: 'string',
      description: 'One-sentence, user-facing description of the Package purpose.'
    },
    code: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Plain JavaScript function body that returns the Host-half Cordis Plugin.'
        },
        client: {
          type: 'string',
          description: 'Plain JavaScript function body that returns the browser Client-half Cordis Plugin.'
        }
      }
    }
  },
  required: [
    'plugin',
    'name',
    'purpose',
    'code'
  ]
};

const CordisRunDescription = [
    "Activate one exact Package of a dynamic Plugin. Use mode:\"run\" for the first activation, restarting ",
    "currentPackageId, or rollback. When current exists, use mode:\"update\" to switch to a different ",
    "Package, even if the Plugin is currently stopped. An unauthorized Client Package creates an ",
    "approval request and returns awaiting-approval; an authorized Package returns starting and ",
    "continues asynchronously in the browser. Neither result waits for the final outcome inside the ",
    "Tool. currentPackageId changes only after complete success; on failure, the old current and target ",
    "next remain. Asynchronous success, rejection, or technical failure is reported through state and ",
    "steering. After a technical failure, read diagnostics with cordis_inspect_self, correct the same ",
    "Plugin, and retry autonomously. Do not request approval again after the user rejects it.",
].join('');
const CordisRunInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    pluginId: {
      type: 'string',
      description: 'Stable Plugin ID returned by cordis_define.'
    },
    packageId: {
      type: 'string',
      description: 'Exact immutable Package ID to activate under that Plugin.'
    },
    mode: {
      type: 'string',
      description: 'Use run for the first activation, restarting current, or rollback; use update to switch from current to a different Package.',
      enum: [
        'run',
        'update'
      ]
    }
  },
  required: [
    'pluginId',
    'packageId',
    'mode'
  ]
};

const CordisStopDescription = [
    "Stop the current Run of a dynamic Plugin and cancel unfinished approval or activation requests. ",
    "Retain the Plugin, every immutable Package, grants, currentPackageId, and nextPackageId so it can ",
    "later run or update directly. Stopping an already stopped Plugin succeeds idempotently. Use this ",
    "Tool to disable effects temporarily; use cordis_undefine for permanent removal.",
].join('');
const CordisStopInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    pluginId: {
      type: 'string',
      description: 'Stable dynamic Plugin ID to stop.'
    }
  },
  required: [
    'pluginId'
  ]
};

const CordisUndefineDescription = [
    "Permanently remove a dynamic Plugin owned by the current Session. If it is running or awaiting ",
    "approval, first stop it and cancel the request, then delete every Package, grant, and version ",
    "pointer. After this returns, its pluginId, packageIds, @ reference, and Package business views are ",
    "invalid; historical cards retain only a \"Plugin removed\" record. Do not call this Tool when ",
    "versions must remain available for restart or rollback; use cordis_stop instead.",
].join('');
const CordisUndefineInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    pluginId: {
      type: 'string',
      description: 'Stable dynamic Plugin ID to remove permanently.'
    }
  },
  required: [
    'pluginId'
  ]
};

export function apply(ctx: Context): void {
    ctx.Tool(ADDON_ID, 'cordis_inspect_list', runtimeToolExecutor('cordis_inspect_list'), {
        ...SESSION_TOOL,
        description: CordisInspectListDescription,
        inputSchema: CordisInspectListInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'cordis_inspect_query', runtimeToolExecutor('cordis_inspect_query'), {
        ...SESSION_TOOL,
        description: CordisInspectQueryDescription,
        inputSchema: CordisInspectQueryInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'cordis_inspect_self', runtimeToolExecutor('cordis_inspect_self'), {
        ...SESSION_TOOL,
        description: CordisInspectSelfDescription,
        inputSchema: CordisInspectSelfInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'cordis_define', runtimeToolExecutor('cordis_define'), {
        ...SESSION_TOOL,
        description: CordisDefineDescription,
        inputSchema: CordisDefineInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'cordis_run', runtimeToolExecutor('cordis_run'), {
        ...SESSION_TOOL,
        description: CordisRunDescription,
        inputSchema: CordisRunInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'cordis_stop', runtimeToolExecutor('cordis_stop'), {
        ...SESSION_TOOL,
        description: CordisStopDescription,
        inputSchema: CordisStopInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'cordis_undefine', runtimeToolExecutor('cordis_undefine'), {
        ...SESSION_TOOL,
        description: CordisUndefineDescription,
        inputSchema: CordisUndefineInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
}
