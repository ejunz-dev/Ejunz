import type { TodoItem } from '@ejunz/ea-core/session/types'

export type { TodoItem } from '@ejunz/ea-core/session/types'

declare module '@ejunz/ea-core/session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The agent's current whole todo list (the latest `todo/write` snapshot),
     * or `null` before the first write. Whole-value rule: every `todo/write`
     * carries the complete replacement list, so the fold is last-wins.
     */
    todos: TodoItem[] | null
  }
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { z as zod } from 'zod'

import type { ZodType } from 'zod'

import { defineTool } from '@ejunz/ea-core/tools'

import type { TodoItem } from '@ejunz/ea-core/session'

import type {} from '@ejunz/ea-core/session-projection'

export const name = 'tool-todo'

export const inject = ['tools']

const STATUSES = ['pending', 'in_progress', 'completed'] as const

export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
}

export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

const DESCRIPTION_HEAD =
  'Record and update a structured task list for the current work. Send the ENTIRE '
  + 'list every call — it REPLACES the previous list (there are no partial updates, '
  + 'no per-item edits). Use it to plan multi-step work and show progress: add one '
  + 'todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'Mark every todo being actively worked '
  + 'on `in_progress` — several at once when work genuinely runs in parallel (e.g. '
  + 'concurrent subagents or background commands), one for sequential work; while '
  + 'work remains, at least one task should be `in_progress`. '

const DESCRIPTION_SINGLE =
  'Keep AT MOST ONE todo `in_progress` at a '
  + 'time; while work remains, exactly one active task should be `in_progress`. '

const DESCRIPTION_TAIL =
  'Mark a todo '
  + '`completed` the moment it is done (do not batch completions), and allow no '
  + '`in_progress` item only once all work is complete. Skip the list for trivial '
  + 'single-step tasks. Statuses: `pending` (not started), `in_progress` (being '
  + 'worked on now), `completed` (finished).'

function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // The unit child activates only when a projection registry is composed
  // (headless assemblies without the seam stay unaffected). Standing-plan fold:
  // latest whole todo/write list, cleared by the next turn/start (turn/end keeps
  // the finished checklist visible); null before the first write or after a
  // later turn begins; every other event returns the same state reference.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'todos', TodoItem[] | null>({
      key: 'todos',
      schema: todosProjectionSchema,
      init: () => null,
      apply: (state, event) => {
        if (event.type === 'todo/write') return event.data.todos
        if (event.type === 'turn/start') return null
        return state
      },
      view: state => state,
      stateVersion: 2,
    })
  })
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/tool-todo'
  export const name = 'tool-todo-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
