import Schema from 'schemastery';
import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import { toGitInput } from '../lib/tool-shared';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

function handlers(): typeof import('ejun/src/handler/base') {
    return require('ejun/src/handler/base');
}

export const StatusSchema = Schema.object({
    githubToken: Schema.string().description('GitHub PAT override for remote fetch (optional).'),
}).description(
    'Get git sync status for this base: local/remote ref, ahead/behind, uncommitted changes, and file change lists. ' +
        'Requires a local git repo (created on first commit/push).',
);

export const CommitSchema = Schema.object({
    commitMessage: Schema.string().description('Commit message body (optional).'),
}).description(
    'Export the current base to the local git working tree and commit (does not push). ' +
        'Use after editing nodes/cards/problems when you want a local snapshot.',
);

export const PushSchema = Schema.object({
    commitMessage: Schema.string().description('Commit message (optional).'),
    githubToken: Schema.string().description('GitHub PAT override (optional).'),
}).description(
    'Commit local changes and push to the configured GitHub remote (`git_config_get`). ' +
        'Requires githubRepo on the base and a GitHub token (user profile or system setting).',
);

export const PullSchema = Schema.object({
    githubToken: Schema.string().description('GitHub PAT override (optional).'),
}).description(
    'Pull from GitHub and import the remote content into this base. ' +
        'Destructive: replaces nodes/cards from the git tree. Requires githubRepo and token.',
);

export const ConfigGetSchema = Schema.object({}).description(
    'Read the GitHub repository URL/path configured for this base (used by git_push / git_pull).',
);

export const ConfigSetSchema = Schema.object({
    githubRepo: Schema.string().required().description('e.g. org/repo, https://github.com/org/repo, or empty string to clear.'),
}).description('Set or clear the GitHub repository for this base. Pass `githubRepo` as owner/repo, full https URL, or null/empty to clear.');

class BaseGitStatusExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return handlers().baseGitStatus(toGitInput(this.ctx, this.args));
    }
}

class BaseGitCommitExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return handlers().baseGitCommit(toGitInput(this.ctx, this.args));
    }
}

class BaseGitPushExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return handlers().baseGitPush(toGitInput(this.ctx, this.args));
    }
}

class BaseGitPullExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return handlers().baseGitPull(toGitInput(this.ctx, this.args));
    }
}

class BaseGitConfigGetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return handlers().baseGitConfigGet({ domainId: this.ctx.domainId, baseDocId: this.ctx.baseDocId });
    }
}

class BaseGitConfigSetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const raw = this.args.githubRepo;
        const githubRepo = raw == null ? null : String(raw).trim();
        return handlers().baseGitConfigSet({ ...toGitInput(this.ctx, this.args), githubRepo: githubRepo || null });
    }
}

export function apply(ctx: Context) {
    const opts = { source: 'base' as const, bindBase: 'session' as const };
    ctx.Tool('base', 'base_git_status', BaseGitStatusExecutor, StatusSchema, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_commit', BaseGitCommitExecutor, CommitSchema, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_push', BaseGitPushExecutor, PushSchema, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_pull', BaseGitPullExecutor, PullSchema, { ...opts, mutating: true }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_config_get', BaseGitConfigGetExecutor, ConfigGetSchema, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_config_set', BaseGitConfigSetExecutor, ConfigSetSchema, { ...opts, mutating: true }, PRIV.USER_PRIV_USER_PROFILE);
}
