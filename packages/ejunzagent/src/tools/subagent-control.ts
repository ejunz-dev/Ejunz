import type { Context } from '@ejunz/cordis'

import { defineTool } from '@ejunz/ea-core/tools'

import type { ContentBlock } from '@ejunz/ea-core/llm'

import { SessionId } from '@ejunz/ea-core/session'

import type {} from '@ejunz/ea-core/subagent'

export const name = 'tool-subagent-control'

export const inject = ['tools', 'subagents']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a message to a background subagent by its subagent id, continuing the same conversation. It '
      + 'becomes the subagent\'s next turn: if it is still working, the message waits until its current turn '
      + 'finishes, so it cannot redirect work already underway. This call returns no answer from the '
      + 'subagent — only confirmation that the message was delivered — so use it to give it more work. A '
      + 'failure means the message was NOT delivered.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message queued as the next turn for subagent ${args.subagent_id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Parent authority requires an exact live calling agent.
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.followup(
        parent,
        SessionId(args.subagent_id),
        message,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        },
      )
      return { messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
      + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
      + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
      + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
      + 'an accepted no-op.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the running agent to interrupt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}

import type { Context } from '@ejunz/cordis'

import { defineTool } from '@ejunz/ea-core/tools'

import type { Agent } from '@ejunz/ea-core/agent'

import type { SessionId } from '@ejunz/ea-core/session'

import { assertNever } from '@ejunz/ea-core/llm'

import type { SubagentDescendantListEntry, SubagentListEntry } from '@ejunz/ea-core/subagent'

export const name = 'tool-subagent-list-agents'

export const inject = ['tools', 'subagents', 'agents']

type ListAgentsScope = 'children' | 'descendants'

interface ListAgentsRequest {
  readonly scope?: ListAgentsScope
}

interface ListAgentsSpec {
  readonly scope: ListAgentsScope
}

type ListAgentsEntry =
  | {
    readonly kind: 'child'
    readonly id: SessionId
    readonly label: string
    readonly status: 'running' | 'idle' | 'ready'
    readonly parent?: SessionId
    readonly depth?: number
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly parent?: SessionId
    readonly depth?: number
  }

function resolveListAgentsRequest(request: ListAgentsRequest): ListAgentsSpec {
  return { scope: request.scope ?? 'children' }
}

function statusOf(agents: { get(id: SessionId): Agent | undefined }, id: SessionId): 'running' | 'idle' | 'ready' {
  const agent = agents.get(id)
  if (agent === undefined) return 'ready'
  return agent.status === 'running' ? 'running' : 'idle'
}

function project(
  agents: { get(id: SessionId): Agent | undefined },
  entry: SubagentListEntry,
  position?: Pick<SubagentDescendantListEntry, 'parentId' | 'depth'>,
): ListAgentsEntry | undefined {
  const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth }
  if (entry.kind === 'diagnostic') {
    return { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at }
  }
  // One-shot children cannot be continued by send_message, so the model
  // never selects them; discovery still traversed them for descendants.
  if (entry.mode !== 'continuable') return undefined
  return {
    kind: 'child',
    id: entry.id,
    label: entry.label,
    status: statusOf(agents, entry.id),
    ...at,
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_agents',
    description:
      'List your continuable background subagents by durable id and label. Use it to recall which ones '
      + 'you started, not to poll for completion — you are told when one finishes. Status comes from the live '
      + 'registry: running means the agent is working right now, idle means it is loaded but between turns '
      + '(it may be waiting on agents it started), and ready means it exists only in storage — resumable, not '
      + 'terminal, and not a result waiting to be collected; a `send_message` starts a new turn on the same '
      + 'conversation, and a direct child remains a `send_message` candidate in every status. The snapshot is not a delivery '
      + 'promise — `send_message` performs the authoritative check and may still fail. Children that could '
      + 'not be read are reported as diagnostics instead of being silently dropped. Scope `descendants` '
      + 'walks the whole tree below you in stable pre-order, annotating each entry with its durable direct-parent '
      + 'session id and depth. You may use `send_message` only for depth-1 entries; deeper entries are '
      + 'candidates for `interrupt_agent` only.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['children', 'descendants'],
        description: 'children (default) lists direct children only; descendants walks the complete tree below you.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['child'] },
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['running', 'idle', 'ready'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['diagnostic'] },
                id: { type: 'string', required: true },
                reason: { type: 'string', required: true, enum: ['corrupt', 'unsupported', 'unavailable'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
          ],
        },
      },
      render: (args, entries) => {
        const request = resolveListAgentsRequest(args)
        return [{
          type: 'text',
          text: entries.length === 0
            ? '(no subagents)'
            : entries.map((entry) => {
              // A descendants row always carries its position; children rows
              // never render it. String() spans the schema-optional shape
              // without a dead fallback branch.
              const at = request.scope === 'descendants'
                ? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
                : ''
              return entry.kind === 'child'
                ? `${entry.id} [${entry.status}]${at} — ${entry.label}`
                : `${entry.id} [diagnostic: ${entry.reason}]${at}`
            }).join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Non-agent callers have no session whose children could be listed.
        throw new Error('list_agents requires a calling agent (exec.agent was undefined)')
      }
      const request = resolveListAgentsRequest(args)
      // The registry drains started tool bodies, so the scan must observe the
      // call's signal rather than finish a slow catalog after cancellation.
      switch (request.scope) {
        case 'children': {
          const entries = await ctx.subagents.listChildren(parent.id, exec.signal)
          return entries
            .map(entry => project(ctx.agents, entry))
            .filter(entry => entry !== undefined)
        }
        case 'descendants': {
          const entries = await ctx.subagents.listDescendants(parent.id, exec.signal)
          return entries
            .map(entry => project(ctx.agents, entry, entry))
            .filter(entry => entry !== undefined)
        }
        /* v8 ignore next 2 -- the resolver normalizes the schema-validated closed scope before dispatch. */
        default:
          return assertNever(request.scope, 'list_agents scope')
      }
    },
  }))
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/tool-subagent-control'
  export const name = 'tool-subagent-control-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
