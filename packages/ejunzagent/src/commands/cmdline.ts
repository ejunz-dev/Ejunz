/**
 * @ejunz/ea-core/cmdline — the command line a ea launcher hands to the app
 * it boots.
 *
 * The launcher parses only its own flags (`--profile`, `--patch`, the config
 * dumps) and hands everything after them to the tree verbatim through the
 * {@link CmdlineArgs} service, so an app owns its flag family, its `--help`
 * text, and its parse errors instead of the launcher knowing them.
 *
 * Any app plugin can inject `cmdlineArgs` and call {@link parseCmdline}. A
 * provider may publish the parsed values as its own service from its program's
 * commander action, and ordinary rows
 * can inject that service and read it from lazily resolved config —
 * `port: !!js ctx.webStartup.port ?? 3080` — so a flag beats the value written
 * beside it. No row has launcher-level command-line status.
 * @module @ejunz/ea-core/cmdline
 */
import type { Command as __m_ext___m_index_0_0_Command } from 'commander';

import type { Context as __m_ext___m_index_1_0_Context } from '@ejunz/cordis';

/**
 * Package-owned invariant companion for `@ejunz/ea-core/cmdline`.
 * @module @ejunz/ea-core/cmdline/invariant
 */
import type { Context as __m_ext___m_invariant_2_0_Context } from '@ejunz/cordis';

import type * as __m_ext_3__ejunz_ea_invariants from "@ejunz/ea-core/invariants";

export namespace __m_index {
/**
 * The invocation's inner arguments: everything after the launcher's own flags,
 * verbatim and in argv order. `ea --profile web --port 8080` yields
 * `['--port', '8080']`.
 */
export interface CmdlineArgs {
    /**
     * Read the inner arguments.
     * @returns the arguments in argv order; empty when the invocation carried none.
     */
    get(): readonly string[];
}
/** Request bounded process exit; the launcher wires it to its shutdown controller. */
export interface AppExit {
    /**
     * Request exit once the tree has been disposed.
     * @param code - the process exit code.
     */
    (code: number): void;
}
/** The launcher facts an app needs. */
export interface CmdlineHost {
    /** The invocation's inner arguments, in argv order. */
    args: readonly string[];
    /** Bounded process-exit request. */
    exit: AppExit;
}
/**
 * Provide the command line and the exit request on a host context before any
 * tree entry mounts. Both are launcher facts, not config: an embedding host
 * with no command line provides an empty argument list.
 * @param ctx - the host context the tree will mount under.
 * @param host - the invocation's arguments and its exit request.
 */
export function provideCmdline(ctx: __m_ext___m_index_1_0_Context, host: CmdlineHost): void {
    const snapshot: readonly string[] = Object.freeze([...host.args]);
    ctx.provide('cmdlineArgs', { get: () => snapshot });
    ctx.provide('appExit', host.exit);
}
/** The process streams commander output is written to; production writes to the process. */
export const internals: {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
} = {
    stdout: process.stdout,
    stderr: process.stderr,
};
/**
 * Parse the launcher's immutable argument snapshot with an app's commander
 * program. Commander runs the program's own synchronous action handler on a
 * successful parse; app code there publishes its service and rejects an
 * invalid invocation with `program.error(...)`. This helper has no Loader-row
 * or service ownership semantics.
 *
 * Help, version, and rejected arguments — from the grammar or from an action
 * — are terminal for the process: commander writes the text and the helper
 * requests `ctx.appExit`. The action never runs on help, version, or a
 * grammar rejection; an action must reject before it publishes, because
 * statements before its `program.error(...)` have already run.
 * @param ctx - plugin context carrying `cmdlineArgs` and `appExit`.
 * @param program - the app's commander program, with its flags, description,
 * actions, and any subcommands already declared.
 * @throws when the launcher did not provide the command line and exit request,
 * or when no command in the program declares an action.
 */
export function parseCmdline(ctx: __m_ext___m_index_1_0_Context, program: __m_ext___m_index_0_0_Command): void {
    // Read through the global service store, not the property proxy: appExit is
    // an optional host value and the plugin only needs to inject cmdlineArgs.
    const args = ctx.get('cmdlineArgs');
    const exit = ctx.get('appExit');
    if (args === undefined || exit === undefined) {
        throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`);
    }
    if (!hasAction(program)) {
        throw new Error(`${program.name()}: no command in the program declares an action; parseCmdline runs the invoked command's action on a successful parse, and app code there publishes its service`);
    }
    configureExitAndOutput(program);
    try {
        program.parse(args.get(), { from: 'user' });
    }
    catch (error) {
        // exitOverride turns help, version, a parse error, and the action's own
        // program.error() into a CommanderError; commander has already written the
        // text through the output configured above.
        if (!isCommanderError(error))
            throw error;
        exit(error.exitCode);
    }
}
/**
 * Whether any command in the tree declares an action handler.
 *
 * The `Command` type cannot express the action precondition, so the handler is
 * read structurally (as {@link isCommanderError} reads commander's control-flow
 * errors): without this guard, a program that forgot its action would parse
 * successfully, publish nothing, and surface only as dependent rows pending on
 * the absent service.
 * @param command - the command whose tree is inspected.
 * @returns true when the command or any registered subcommand has an action.
 */
function hasAction(command: __m_ext___m_index_0_0_Command): boolean {
    if (typeof (command as unknown as {
        _actionHandler?: unknown;
    })._actionHandler === 'function')
        return true;
    return command.commands.some(hasAction);
}
/**
 * Route every command's exit and output through the launcher adapter.
 *
 * Commander copies `exitOverride` and output configuration into a subcommand
 * only at registration, so a root-only override would let an
 * already-registered subcommand's rejection write to the process streams and
 * call `process.exit` directly, bypassing `ctx.appExit`.
 * @param command - the root of the command tree to configure.
 */
function configureExitAndOutput(command: __m_ext___m_index_0_0_Command): void {
    command
        .exitOverride()
        .configureOutput({
        writeOut: text => void internals.stdout.write(text),
        writeErr: text => void internals.stderr.write(text),
    });
    for (const child of command.commands)
        configureExitAndOutput(child);
}
/**
 * Whether a thrown value is commander's own control-flow error (help, version,
 * a parse error, or `program.error`).
 *
 * Detected structurally, not with `instanceof`: an out-of-tree plugin brings
 * its own commander copy, whose `CommanderError` class is a different identity
 * from this package's, and an identity check there would rethrow a printed
 * help as a fatal load failure.
 * @param error - the thrown value.
 * @returns true when the value carries commander's error code and exit code.
 */
function isCommanderError(error: unknown): error is {
    code: string;
    exitCode: number;
} {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error as {
        code?: unknown;
        exitCode?: unknown;
    };
    return typeof candidate.code === 'string' && candidate.code.startsWith('commander.')
        && typeof candidate.exitCode === 'number';
}

}

export namespace __m_invariant {
const PACKAGE_NAME = '@ejunz/ea-core/cmdline';
/** Cordis companion plugin name. */
export const name = 'cmdline-invariant';
/** Service required before the companion can register. */
export const inject = ['invariants'];
/**
 * No runtime invariant: `cmdlineArgs` is an immutable launcher fact that any
 * number of ordinary plugins may read. App-owned providers and consumers use
 * normal Cordis service injection, whose missing dependencies are already
 * reported by Loader settlement.
 */
const install: __m_ext_3__ejunz_ea_invariants.InvariantInstaller = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: __m_ext___m_invariant_2_0_Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));

}

export namespace __api {
  export import provideCmdline = __m_index.provideCmdline
  export import parseCmdline = __m_index.parseCmdline
  export import CmdlineArgs = __m_index.CmdlineArgs
  export import AppExit = __m_index.AppExit
  export import CmdlineHost = __m_index.CmdlineHost
  export import internals = __m_index.internals
}

export import provideCmdline = __api.provideCmdline

export import parseCmdline = __api.parseCmdline

export import CmdlineArgs = __api.CmdlineArgs

export import AppExit = __api.AppExit

export import CmdlineHost = __api.CmdlineHost

export import internals = __api.internals

export namespace __invariant {
  export import name = __m_invariant.name
  export import inject = __m_invariant.inject
  export import apply = __m_invariant.apply
}

export import __invariant_companion = __invariant

export default __api

declare module '@ejunz/cordis' {
    interface Context {
        /** The invocation's inner arguments; provided by a launcher before the tree mounts. */
        cmdlineArgs?: __m_index.CmdlineArgs;
        /** Bounded process-exit request; provided by a launcher before the tree mounts. */
        appExit?: __m_index.AppExit;
    }
}

