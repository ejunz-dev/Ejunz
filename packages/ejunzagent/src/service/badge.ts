import { readFile } from 'node:fs/promises'

import { fileURLToPath } from 'node:url'

import type { Context } from '@ejunz/cordis'

import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@ejunz/ea-core/skill'

const PROVIDER_NAME = 'ea-badge'

const SKILL_BODY_URL = new URL('../assets/ea-badge.md', import.meta.url)

const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const

const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const DESCRIPTION = 'Add the official “powered by ea” badge to documents, pull requests, merge requests, and other content produced with EjunzAgent. Use whenever creating a pull request or merge request. Also use when the user asks for a ea badge, powered-by-ea attribution, or a reusable ea badge asset or snippet.'

const CANDIDATE: SkillCandidate = {
  name: 'ea-badge',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

export const name = 'skill-badge'

export const inject = ['skills']

export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/skill-badge'
  export const name = 'skill-badge-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
