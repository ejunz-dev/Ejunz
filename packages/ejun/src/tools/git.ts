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

export const Status = Schema.object({
    githubToken: Schema.string().description('GitHub PAT override for remote fetch (optional).'),
}).description('Get git sync status for this base: local/remote ref, ahead/behind, uncommitted changes, and file change lists. '
    + 'Requires a local git repo (created on first commit/push).');

export const Commit = Schema.object({
    commitMessage: Schema.string().description('Commit message body (optional).'),
}).description('Export the current base to the local git working tree and commit (does not push). '
    + 'Use after editing nodes/cards/problems when you want a local snapshot.');

export const Push = Schema.object({
    commitMessage: Schema.string().description('Commit message (optional).'),
    githubToken: Schema.string().description('GitHub PAT override (optional).'),
}).description('Commit local changes and push to the configured GitHub remote (`git_config_get`). '
    + 'Requires githubRepo on the base and a GitHub token (user profile or system setting).');

export const Pull = Schema.object({
    githubToken: Schema.string().description('GitHub PAT override (optional).'),
}).description('Pull from GitHub and import the remote content into this base. '
    + 'Destructive: replaces nodes/cards from the git tree. Requires githubRepo and token.');

export const ConfigGet = Schema.object({}).description(
    'Read the GitHub repository URL/path configured for this base (used by git_push / git_pull).',
);

export const ConfigSet = Schema.object({
    githubRepo: Schema.string().required().description('e.g. org/repo, https://github.com/org/repo, or empty string to clear.'),
}).description('Set or clear the GitHub repository for this base. Pass `githubRepo` as owner/repo, full https URL, or null/empty to clear.');

export async function status(ctx: ToolContext, args: ToolArgs) {
    return handlers().baseGitStatus(toGitInput(ctx, args));
}

export async function commit(ctx: ToolContext, args: ToolArgs) {
    return handlers().baseGitCommit(toGitInput(ctx, args));
}

export async function push(ctx: ToolContext, args: ToolArgs) {
    return handlers().baseGitPush(toGitInput(ctx, args));
}

export async function pull(ctx: ToolContext, args: ToolArgs) {
    return handlers().baseGitPull(toGitInput(ctx, args));
}

export async function configGet(ctx: ToolContext, _args: ToolArgs) {
    return handlers().baseGitConfigGet({ domainId: ctx.domainId, baseDocId: ctx.baseDocId });
}

export async function configSet(ctx: ToolContext, args: ToolArgs) {
    const raw = args.githubRepo;
    const githubRepo = raw == null ? null : String(raw).trim();
    return handlers().baseGitConfigSet({ ...toGitInput(ctx, args), githubRepo: githubRepo || null });
}

class BaseGitStatusExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return status(this.context, this.args);
    }
}

class BaseGitCommitExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return commit(this.context, this.args);
    }
}

class BaseGitPushExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return push(this.context, this.args);
    }
}

class BaseGitPullExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return pull(this.context, this.args);
    }
}

class BaseGitConfigGetExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return configGet(this.context, this.args);
    }
}

class BaseGitConfigSetExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return configSet(this.context, this.args);
    }
}

export function apply(ctx: Context) {
    const opts = { source: 'base' as const, bindBase: 'session' as const };
    ctx.Tool('base', 'base_git_status', BaseGitStatusExecutor, Status, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_commit', BaseGitCommitExecutor, Commit, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_push', BaseGitPushExecutor, Push, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_pull', BaseGitPullExecutor, Pull, { ...opts, mutating: true }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_config_get', BaseGitConfigGetExecutor, ConfigGet, opts, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_git_config_set', BaseGitConfigSetExecutor, ConfigSet, { ...opts, mutating: true }, PRIV.USER_PRIV_USER_PROFILE);
}
