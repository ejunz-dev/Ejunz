import type { Context } from '../context';
import { ConnectionHandler, Handler } from '@ejunz/framework';
import { PRIV } from '../model/builtin';
import type { RuntimeLink } from '../service/runtime';
import type { AgentStorageDescriptor } from '../model/agent';
import type { RuntimeHelloFrame, RuntimeInboundFrame, RuntimeLinkPollFrame, RuntimeStream } from '../service/runtime';
import { agentRuntimeHandlerContext as service } from '../service/runtime';

interface RpcEnvelope {
    type?: string;
    rpcId?: string;
    method?: string;
    payload?: Record<string, unknown>;
    domainId?: string;
}
const { requireBridgeToken, baseSessionScope, toolRegistry, scopeOf, rpcOk, rpcError, serverRequestFrame, callUpstream, workspaceRpc, domainSettingsRpc, domainCredentialsRpc, baseTutorEnsure, baseTutorList, baseTutorCreate, baseTutorHistory, baseTutorPrompt, linkStatus, linkApprove, runtimeStatusItems, runtimeRelabel, runtimeRemove, sessionCreate, sessionHistory, sessionMessageCount, sessionContextSave, sessionSetHost, HostUnreachableError, linkForSession, requireLink, logger, RUNTIME_HELLO_TIMEOUT_MS, addLink, rememberRuntime, reportRuntime, agentDataAdapter, AgentStorageModel, AgentLinkModel, createProvider, SystemModel, randomUUID, WebSocket, parseRuntimeFrame, createSocketLink, followLinks, runtimeLinks, runtimeFacts, bridgeRuntimeId, mergeDomainProviders, mergeDomainModels, cloneSettingsSections } = service;
const dataOk = (value: unknown): Record<string, unknown> => ({ ok: true, value });
const dataError = (message: string): Record<string, unknown> => ({ ok: false, error: { message } });

export class EjunzAgentDataHandler extends Handler<Context> {
    noCheckPermView = true;

    async post() {
        const bridgeToken = this.request.headers?.['x-ejunz-agent-token'];
        await requireBridgeToken(bridgeToken);
        await service.modelReady();
        const method = Array.isArray(this.args?.method) ? this.args.method.join('/') : String(this.args?.method || '');
        const body = (this.request.body ?? {}) as Record<string, unknown>;
        try {
            if (method === 'storage/open') {
                const descriptor = body.descriptor as AgentStorageDescriptor;
                await AgentStorageModel.open({
                    name: String(descriptor.name),
                    version: Number(descriptor.version),
                    tables: Array.isArray(descriptor.tables) ? descriptor.tables.map(String) : [],
                    hasGlobal: descriptor.hasGlobal === true,
                });
                this.response.body = JSON.stringify(dataOk(null));
            } else if (method === 'storage/load') {
                this.response.body = JSON.stringify(dataOk(await AgentStorageModel.load(String(body.name || ''))));
            } else if (method === 'storage/put') {
                await AgentStorageModel.put(String(body.name || ''), String(body.table || ''), String(body.key || ''), body.value);
                this.response.body = JSON.stringify(dataOk(null));
            } else if (method === 'storage/delete') {
                await AgentStorageModel.delete(String(body.name || ''), String(body.table || ''), String(body.key || ''));
                this.response.body = JSON.stringify(dataOk(null));
            } else if (method === 'storage/setGlobal') {
                await AgentStorageModel.setGlobal(String(body.name || ''), body.value);
                this.response.body = JSON.stringify(dataOk(null));
            } else if (method === 'domain/runtime') {
                const sessionId = String(body.sessionId || '');
                this.response.body = JSON.stringify(dataOk(await agentDataAdapter.domainRuntime(sessionId) ?? null));
            } else if (method === 'tools/scope') {
                const sessionId = String(body.sessionId || '');
                const { scope } = await baseSessionScope(sessionId, true);
                if (scope) logger.info('[agent-tools] scope session=%s domain=%s baseId=%d owner=%d', sessionId, scope.domain, scope.baseId, scope.owner);
                this.response.body = JSON.stringify(dataOk(scope ?? null));
            } else if (method === 'tools/catalog') {
                // The catalog is per session: a caller that names one receives the tools
                // its domain publishes, and a caller with no session yet (an Agent process
                // starting up, before any session exists) receives the domain-independent
                // set, with unscoped guidance.
                const sessionId = String(body.sessionId || '');
                const resolved = sessionId ? await baseSessionScope(sessionId, true) : { session: undefined, scope: undefined };
                const scope = resolved.scope ?? (resolved.session
                    ? { domain: resolved.session.domainId, baseId: 0, owner: resolved.session.userId }
                    : undefined);
                const tools = toolRegistry();
                const context = {
                    domainId: scope?.domain || '',
                    baseDocId: scope?.baseId || 0,
                    ...(sessionId ? { sessionId } : {}),
                };
                let access: { priv: number; perm: bigint; scope: bigint } | undefined;
                if (scope?.owner && scope.domain) {
                    const UserModel = (global as any).Ejunz?.model?.user;
                    const user = UserModel ? await UserModel.getById(scope.domain, scope.owner) : null;
                    if (user) access = { priv: user.priv, perm: user.perm, scope: user.scope };
                }
                this.response.body = JSON.stringify(dataOk({
                    tools: tools.list(undefined, scope?.domain, access),
                    guidance: (await tools.instructions(context)).join('\n\n'),
                }));
            } else if (method === 'tools/call') {
                const sessionId = String(body.sessionId || '');
                const name = String(body.name || '');
                const resolved = await baseSessionScope(sessionId, true);
                if (!resolved.session) throw new Error('Base session not found');
                const scope = resolved.scope ?? { domain: resolved.session.domainId, baseId: 0, owner: resolved.session.userId };
                const args = body.args;
                if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be an object');
                const startedAt = Date.now();
                logger.info('[agent-base] call start session=%s name=%s domain=%s baseId=%d owner=%d', sessionId, name, scope.domain, scope.baseId, scope.owner);
                try {
                    const ejunzContext = (global as any).app || (global as any).Ejunz;
                    if (!ejunzContext) throw new Error('Ejunz context is unavailable');
                    const provider = createProvider(ejunzContext, {
                        domainId: scope.domain,
                        owner: scope.owner,
                        baseDocId: scope.baseId,
                        sessionId,
                    });
                    const result = await provider.call(name, args as Record<string, unknown>, new AbortController().signal);
                    logger.info('[agent-base] call done session=%s name=%s domain=%s baseId=%d durationMs=%d', sessionId, name, scope.domain, scope.baseId, Date.now() - startedAt);
                    this.response.body = JSON.stringify(dataOk(result));
                } catch (error) {
                    logger.warn('[agent-base] call failed session=%s name=%s domain=%s baseId=%d durationMs=%d error=%s', sessionId, name, scope.domain, scope.baseId, Date.now() - startedAt, error instanceof Error ? error.message : String(error));
                    throw error;
                }
            } else if (method === 'session/create') {
                const meta = body.meta;
                const id = typeof meta === 'object' && meta !== null ? String((meta as Record<string, unknown>).id || '') : '';
                if (id && typeof meta === 'object' && meta !== null) await agentDataAdapter.setSessionHeader(id, meta as Record<string, unknown>);
                this.response.body = JSON.stringify(dataOk(null));
            } else if (method === 'session/append') {
                const sessionId = String(body.sessionId || '');
                const events = Array.isArray(body.events)
                    ? body.events.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === 'object')
                    : [];
                const meta = body.meta;
                const owned = await agentDataAdapter.getSessionAny(sessionId);
                const ownerHost = owned?.runtimeId ?? '';
                const writerHost = await bridgeRuntimeId(bridgeToken);
                if (ownerHost !== '' && writerHost !== undefined && writerHost !== ownerHost) {
                    // Same session, switched host: the previous host may still
                    // flush write-behind. Acknowledge without writing so the
                    // owner host can keep the shared log contiguous.
                    logger.info(
                        'Agent session/append ignored from previous host session=%s writer=%s owner=%s events=%d',
                        sessionId,
                        writerHost,
                        ownerHost,
                        events.length,
                    );
                    this.response.body = JSON.stringify(dataOk(null));
                } else {
                    try {
                        if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
                            await agentDataAdapter.setSessionHeader(sessionId, meta as Record<string, unknown>);
                        }
                        await agentDataAdapter.appendEventsAny(sessionId, events);
                        this.response.body = JSON.stringify(dataOk(null));
                    } catch (error) {
                        // Ownership can flip between the check above and the write,
                        // and a hot reload can leave the previous host's token
                        // unmapped (writerHost undefined). Either way a late flush
                        // that loses the race must not fail the turn once another
                        // host already owns the session.
                        const message = error instanceof Error ? error.message : String(error);
                        const latest = await agentDataAdapter.getSessionAny(sessionId);
                        const latestOwner = latest?.runtimeId ?? '';
                        const staleWriter = latestOwner !== '' && (writerHost === undefined || writerHost !== latestOwner);
                        if (message.includes('payload conflict') && staleWriter) {
                            logger.info(
                                'Agent session/append conflict ignored from previous host session=%s writer=%s owner=%s',
                                sessionId,
                                writerHost ?? '(unmapped)',
                                latestOwner,
                            );
                            this.response.body = JSON.stringify(dataOk(null));
                        } else {
                            throw error;
                        }
                    }
                }
            } else if (method === 'session/load' || method === 'session/inspect') {
                const sessionId = String(body.sessionId || '');
                const session = await agentDataAdapter.getSessionAny(sessionId);
                if (!session?.header) this.response.body = JSON.stringify(dataError('session not found'));
                else this.response.body = JSON.stringify(dataOk({ meta: session.header, events: await agentDataAdapter.loadEventsAny(sessionId) }));
            } else if (method === 'session/readFrom') {
                const sessionId = String(body.sessionId || '');
                const fromSeq = Number(body.fromSeq || 0);
                const session = await agentDataAdapter.getSessionAny(sessionId);
                const events = (await agentDataAdapter.loadEventsAny(sessionId)).filter((event) => Number(event.seq) >= fromSeq);
                this.response.body = JSON.stringify(dataOk({ meta: session?.header, events }));
            } else if (method === 'session/readTail') {
                const sessionId = String(body.sessionId || '');
                const beforeSeq = typeof body.beforeSeq === 'number' ? body.beforeSeq : undefined;
                const limit = Math.min(Math.max(Number(body.limit) || 1, 1), 10000);
                const session = await agentDataAdapter.getSessionAny(sessionId);
                if (!session?.header) this.response.body = JSON.stringify(dataError('session not found'));
                else {
                    const page = await agentDataAdapter.listEventsTailAny(sessionId, beforeSeq, limit);
                    this.response.body = JSON.stringify(dataOk({ meta: session.header, events: page.events, hasMore: page.hasMore }));
                }
            } else if (method === 'session/list' || method === 'session/listSnapshots') {
                const rows = (await agentDataAdapter.listAllSessions()).filter((row) => row.header);
                const value = method === 'session/list'
                    ? rows.map((row) => row.header)
                    : rows.map((row) => ({ header: row.header, revision: `${row.updatedAt}` }));
                this.response.body = JSON.stringify(dataOk(value));
            } else {
                this.response.body = JSON.stringify(dataError(`unsupported agent data method: ${method}`));
            }
        } catch (error) {
            const message = error instanceof Error
                ? (error.message || error.name)
                : (typeof error === 'string' ? error : (() => {
                    try { return JSON.stringify(error); } catch { return String(error); }
                })());
            this.response.body = JSON.stringify(dataError(message));
        }
        this.response.type = 'application/json';
    }
}


export class EjunzAgentPageHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = 'agent';
    }
}


export class EjunzAgentLinkPageHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = 'ejunz_agent_link.html';
    }
}


export class EjunzAgentStatusPageHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = 'ejunz_agent_status.html';
    }
}


export class EjunzAgentRpcHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await service.modelReady();
        const envelope = (this.request.body ?? {}) as RpcEnvelope;
        const rawMethod = this.args?.method;
        const method = Array.isArray(rawMethod) ? rawMethod.join('/') : String(rawMethod || envelope.method || '');
        if (!/^[A-Za-z][A-Za-z0-9._$/-]*$/.test(method)) throw new Error('bad method');
        envelope.method = method;
        const scope = scopeOf(this, envelope.domainId);
        try {
            await this.dispatch(envelope, scope);
        } catch (error) {
            if (!(error instanceof HostUnreachableError)) throw error;
            // A session whose host is down has no answer this server can give
            // in its place, so the reason reaches the page as the RPC's failure.
            this.response.status = 503;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcError(envelope.rpcId, error.message));
        }
    }

    private async dispatch(envelope: RpcEnvelope, scope: { domainId: string; userId: number }): Promise<void> {
        const method = String(envelope.method || '');
        if (method === 'settings.describe' || method === 'settings.update' || method === 'settings.replace' || method === 'settings.mutate') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await domainSettingsRpc(envelope, scope));
            return;
        }
        if (method === 'credentials.describe' || method === 'credentials.set' || method === 'credentials.unset') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await domainCredentialsRpc(envelope, scope));
            return;
        }
        if (method === 'ui.displayPrefs.get') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, { display: await agentDataAdapter.getDisplayPrefs(scope) }));
            return;
        }
        if (method === 'ui.displayPrefs.save') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, {
                display: await agentDataAdapter.saveDisplayPrefs(scope, envelope.payload?.display),
            }));
            return;
        }
        if (method.startsWith('workspace.')) {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await workspaceRpc(envelope, scope));
            return;
        }
        if (method === 'base.list') {
            const baseModel = (global as any).Ejunz?.model?.base;
            if (!baseModel) {
                this.response.type = 'application/json';
                this.response.body = JSON.stringify(rpcError(envelope.rpcId, 'Ejunz Base model is unavailable'));
                return;
            }
            const bases = await baseModel.getAll(scope.domainId);
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, {
                items: bases.map((base: { docId: number; title?: string; slug?: string }) => ({
                    docId: Number(base.docId),
                    title: String(base.title || `Base #${base.docId}`),
                    ...(base.slug ? { slug: String(base.slug) } : {}),
                })),
            }));
            return;
        }
        if (method === 'baseTutor.ensure') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await baseTutorEnsure(envelope, scope));
            return;
        }
        if (method === 'baseTutor.list') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await baseTutorList(envelope, scope));
            return;
        }
        if (method === 'baseTutor.create') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await baseTutorCreate(envelope, scope));
            return;
        }
        if (method === 'baseTutor.history') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await baseTutorHistory(envelope, scope));
            return;
        }
        if (method === 'baseTutor.prompt') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await baseTutorPrompt(envelope, scope));
            return;
        }
        if (method === 'link.status') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await linkStatus(envelope));
            return;
        }
        if (method === 'link.approve') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await linkApprove(envelope, scope));
            return;
        }
        if (method === 'host.status') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, { items: await runtimeStatusItems() }));
            return;
        }
        if (method === 'host.label') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await runtimeRelabel(envelope));
            return;
        }
        if (method === 'host.remove') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await runtimeRemove(envelope));
            return;
        }
        if (method === 'session.list') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, { items: await agentDataAdapter.listSessions(scope) }));
            return;
        }
        if (method === 'session.create') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await sessionCreate(envelope, scope));
            return;
        }
        if (method === 'session.history') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await sessionHistory(envelope, scope));
            return;
        }
        if (method === 'session.count') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await sessionMessageCount(envelope, scope));
            return;
        }
        if (method === 'session.context.save') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await sessionContextSave(envelope, scope));
            return;
        }
        if (method === 'session.setHost') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await sessionSetHost(envelope, scope));
            return;
        }
        if (method === 'session.delete') {
            const sessionId = String(envelope.payload?.sessionId || '');
            if (!await agentDataAdapter.getSession(scope, sessionId)) {
                this.response.type = 'application/json';
                this.response.body = JSON.stringify(rpcError(envelope.rpcId, 'session not found'));
                return;
            }
            await agentDataAdapter.deleteSession(scope, sessionId);
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, { deleted: true }));
            return;
        }
        if (method === 'session.deleteMany') {
            const sessionIds = Array.isArray(envelope.payload?.sessionIds)
                ? [...new Set(envelope.payload.sessionIds.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))]
                : [];
            if (sessionIds.length === 0) {
                this.response.type = 'application/json';
                this.response.body = JSON.stringify(rpcError(envelope.rpcId, 'sessionIds are required'));
                return;
            }
            await agentDataAdapter.deleteSessions(scope, sessionIds);
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, { deleted: sessionIds.length }));
            return;
        }
        if (method === 'session.search') {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcOk(envelope.rpcId, { items: await agentDataAdapter.search(scope, String(envelope.payload?.query || '')), hasMore: false }));
            return;
        }
        if (method === 'pluginInventory/sessionList') {
            const args = envelope.payload?.args;
            const agentId = typeof args === 'object' && args !== null && !Array.isArray(args)
                ? (args as Record<string, unknown>).agentId
                : undefined;
            if (typeof agentId !== 'string' || !await agentDataAdapter.getSession(scope, agentId)) {
                this.response.type = 'application/json';
                this.response.body = JSON.stringify(rpcError(envelope.rpcId, 'session not found'));
                return;
            }
        }
        const sessionId = typeof envelope.payload?.sessionId === 'string' ? envelope.payload.sessionId : undefined;
        if (sessionId && !await agentDataAdapter.getSession(scope, sessionId)) {
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(rpcError(envelope.rpcId, 'session not found'));
            return;
        }
        const payload = { ...(envelope.payload ?? {}) };
        delete (payload as Record<string, unknown>).domainId;
        if (method === 'session.selectModel') payload.persistDefault = false;
        // A call about one session goes to the host that session names, so a
        // switched session continues on the host an operator chose.
        const upstream = await callUpstream(method, payload, sessionId === undefined ? undefined : await linkForSession(scope, sessionId));
        if (method === 'llm.providers' || method === 'llm.models' || method === 'session.models') {
            const domainSettings = await agentDataAdapter.getDomainSettings(scope.domainId);
            upstream.body = method === 'llm.providers'
                ? mergeDomainProviders(upstream.body, domainSettings.sections)
                : mergeDomainModels(upstream.body, domainSettings.sections);
        }
        if (method === 'session.selectModel' && upstream.body.result?.ok && sessionId) {
            const provider = typeof payload.provider === 'string' ? payload.provider : '';
            const model = typeof payload.model === 'string' ? payload.model : '';
            if (provider && model) {
                await agentDataAdapter.updateSession(scope, sessionId, { model: { provider, model } });
                const domainSettings = await agentDataAdapter.getDomainSettings(scope.domainId);
                const nextSections = cloneSettingsSections(domainSettings.sections);
                nextSections['agent-default-model'] = {
                    provider,
                    model,
                    ...(typeof payload.reasoningEffort === 'string' ? { reasoningEffort: payload.reasoningEffort } : {}),
                };
                if (!await agentDataAdapter.updateDomainSettings(scope.domainId, nextSections, domainSettings.revision)) {
                    logger.warn('agent model default update lost a concurrent domain settings change domain=%s', scope.domainId);
                }
            }
        }
        if (method === 'session.rename' && upstream.body.result?.ok && sessionId) {
            const title = String((upstream.body.result.value as Record<string, unknown>)?.title || '');
            if (title) {
                const existing = await agentDataAdapter.getSession(scope, sessionId);
                await agentDataAdapter.updateSession(scope, sessionId, {
                    projections: { values: { ...(existing?.projections?.values ?? {}), title } },
                });
            }
        }
        if (method === 'session.fork' && upstream.body.result?.ok && sessionId) {
            const childId = String((upstream.body.result.value as Record<string, unknown>)?.sessionId || '');
            const parent = await agentDataAdapter.getSession(scope, sessionId);
            if (childId && parent) {
                await agentDataAdapter.upsertSession(scope, {
                    sessionId: childId,
                    updatedAt: Date.now(),
                    running: false,
                    blank: false,
                    creatorUserId: scope.userId,
                    type: parent.type ?? 'generic',
                    ...(parent.baseDocId === undefined ? {} : { baseDocId: parent.baseDocId }),
                    ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
                    ...(parent.agentPreset === undefined ? {} : { agentPreset: parent.agentPreset }),
                    ...(parent.model === undefined ? {} : { model: parent.model }),
                });
            }
        }
        this.response.status = upstream.status;
        this.response.type = 'application/json';
        this.response.body = JSON.stringify(upstream.body);
    }
}


export class EjunzAgentResponseHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await service.modelReady();
        const body = (this.request.body ?? {}) as Record<string, unknown>;
        const result = body.result as Record<string, unknown> | undefined;
        const value = result?.value as Record<string, unknown> | undefined;
        const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : undefined;
        const scope = scopeOf(this, body.domainId);
        if (sessionId && !await agentDataAdapter.getSession(scope, sessionId)) throw new Error('session not found');
        // An answer belongs to the turn that asked for it, so it goes back to
        // the host that turn runs on.
        let target: RuntimeLink;
        try {
            target = sessionId === undefined ? await requireLink() : await linkForSession(scope, sessionId);
        } catch (error) {
            if (!(error instanceof HostUnreachableError)) throw error;
            this.response.status = 503;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify({ error: { message: error.message } });
            return;
        }
        const reply = await target.call('/api/respond', body);
        this.response.status = reply.status;
        this.response.type = reply.contentType;
        this.response.body = reply.text;
    }
}


export class EjunzAgentSseHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.status = 501;
        this.response.type = 'text/plain; charset=utf-8';
        this.response.body = 'the client-plugin event channel is unavailable in an embedded deployment';
    }
}


export class EjunzAgentEventsConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;

    private frames: AbortController | null = null;
    private keepAlive: ReturnType<typeof setInterval> | null = null;
    private sendChain: Promise<void> = Promise.resolve();
    private domainId = '';
    private userId = 0;

    async prepare() {
        const stream = String(this.args?.stream || '');
        if (stream !== 'events.mux' && stream !== 'events.host') {
            this.close(4000, 'unknown stream');
            return;
        }
        await service.modelReady();
        const scope = scopeOf(this, this.request.query?.domainId);
        this.domainId = scope.domainId;
        this.userId = scope.userId;
        const runtimeStream: RuntimeStream = stream === 'events.mux' ? 'mux' : 'host';
        const frames = new AbortController();
        this.frames = frames;
        // One pump per reachable runtime, and one more whenever another runtime
        // connects: a page shows the sessions of whichever host served them, and
        // a host may start while this page is open.
        const follow = (link: RuntimeLink): void => {
            this.pumpRuntime(link, runtimeStream).catch((error) => {
                // A dead stream must reach the page as a frame, not as a silent
                // close: the browser distinguishes "no more events" from "this
                // stream broke" only by what arrives on it.
                if (frames.signal.aborted) return;
                logger.warn('Agent event stream failed stream=%s error=%s', stream, error instanceof Error ? error.message : String(error));
                try {
                    this.conn.send(JSON.stringify({
                        type: 'server-request',
                        rpcId: `stream-${randomUUID()}`,
                        payload: { type: 'stream/error', error: { code: 'internal', message: String(error), details: {} } },
                    }));
                } catch { }
            });
        };
        const stopFollowing = followLinks(follow);
        const tearDown = () => {
            stopFollowing();
            if (this.keepAlive) clearInterval(this.keepAlive);
            this.keepAlive = null;
            frames.abort();
            try { this.conn.close(); } catch { }
        };
        this.conn.on('close', tearDown);
        this.keepAlive = setInterval(() => {
            try { if (this.conn.readyState === WebSocket.OPEN) this.conn.ping(); } catch { }
        }, 25000);
        (this.keepAlive as unknown as { unref?: () => void }).unref?.();
    }

    /**
     * Forward one runtime's frames of one stream to this page, persisting what
     * the frame changes on the way.
     * @param link - the runtime to follow.
     * @param stream - which of its streams to follow.
     */
    private async pumpRuntime(link: RuntimeLink, stream: RuntimeStream): Promise<void> {
        for await (const frame of link.subscribe(stream)) {
            await (this.sendChain = this.sendChain.then(async () => {
                    const payload = frame.payload;
                    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
                    const session = sessionId === undefined
                        ? undefined
                        : await agentDataAdapter.getSession({ domainId: this.domainId, userId: this.userId }, sessionId);
                    if (sessionId !== undefined && !session) return;
                    const type = String(payload?.type || '');
                    if (type === 'session/projection' && sessionId !== undefined) {
                        const current = await agentDataAdapter.getSession({ domainId: this.domainId, userId: this.userId }, sessionId);
                        const key = String(payload?.key || '');
                        await agentDataAdapter.updateSession({ domainId: this.domainId, userId: this.userId }, sessionId, {
                            projections: { values: { ...(current?.projections?.values ?? {}), [key]: payload?.value } },
                            updatedAt: Date.now(),
                        });
                    } else if (type === 'host/session-status' && sessionId !== undefined) {
                        await agentDataAdapter.updateSession({ domainId: this.domainId, userId: this.userId }, sessionId, { running: payload?.running === true });
                    } else if (type === 'host/session-removed' && sessionId !== undefined) {
                        await agentDataAdapter.updateSession({ domainId: this.domainId, userId: this.userId }, sessionId, { archived: true });
                    }
                try { this.conn.send(JSON.stringify(serverRequestFrame(frame))); } catch { }
            }).catch((error) => logger.warn('Agent event persistence failed: %o', error)));
        }
    }

    /**
     * These channels are downlink-only: the runtime's own carrier closes a
     * socket that sends anything upstream, and every browser-to-host call
     * travels the request routes instead.
     */
    async message(msg: unknown) {
        void msg;
    }
}


export class EjunzAgentRuntimeConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;

    private link: RuntimeLink | null = null;
    private identifyTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly frameListeners: ((frame: RuntimeInboundFrame) => void)[] = [];
    private readonly closeListeners: (() => void)[] = [];
    /** The identity assigned to this connection, for its row and its logs. */
    private runtimeIdValue = '';
    /** The pairing request this socket opened, while it waits for an operator. */
    private pairing: { code: string; pairSecret: string } | null = null;

    private sendFrame(frame: unknown): boolean {
        if (this.conn.readyState !== WebSocket.OPEN) return false;
        try {
            this.conn.send(JSON.stringify(frame));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Arm the identification deadline.
     *
     * Identification happens in the first message, not here: this carrier
     * installs its message listener only once `prepare` has returned, so a
     * handler that waited for the runtime's first frame here would wait for a
     * frame it can never be given.
     */
    async prepare() {
        this.identifyTimer = setTimeout(() => { void this.rejectUnidentified(); }, RUNTIME_HELLO_TIMEOUT_MS);
        (this.identifyTimer as unknown as { unref?: () => void }).unref?.();
        this.conn.on('close', () => { void this.release(); });
    }

    async message(raw: unknown) {
        const frame = parseRuntimeFrame(raw);
        if (frame === undefined) return;
        if (frame.key === 'hello') {
            await this.identify(frame);
            return;
        }
        if (frame.key === 'link-poll') {
            await this.answerLinkPoll(frame);
            return;
        }
        // Nothing else is meaningful before the runtime has said what it is.
        if (this.link === null) return;
        if (frame.key === 'status') {
            if (!this.runtimeIdValue) return;
            await agentDataAdapter.touchRuntime(this.runtimeIdValue, Number(frame.attachedSessions) || 0);
            return;
        }
        if (frame.key === 'pong') return;
        for (const listener of this.frameListeners.slice()) listener(frame);
    }

    /** Refuse a connection that never identified itself. */
    private async rejectUnidentified(): Promise<void> {
        this.identifyTimer = null;
        if (this.link !== null) return;
        this.sendFrame({ key: 'hello', accepted: false, reason: 'the runtime did not identify itself' });
        this.close(4001, 'no hello');
    }

    /**
     * Answer one registration: serve a runtime that holds a binding, and offer a
     * pairing request to one that does not.
     * @param hello - the runtime's registration frame.
     */
    private async identify(hello: RuntimeHelloFrame): Promise<void> {
        if (this.link !== null || this.pairing !== null) return;
        if (this.identifyTimer) {
            clearTimeout(this.identifyTimer);
            this.identifyTimer = null;
        }
        const token = String(hello.token || this.headerToken() || '');
        const binding = token === '' ? undefined : await AgentLinkModel.findByToken(token);
        if (binding === undefined) {
            await this.beginPairing(hello, token !== '');
            return;
        }
        await this.serve(hello, binding);
    }

    /** The credential a runtime may carry on the upgrade request instead of in its hello. */
    private headerToken(): string {
        const header = String(this.request.headers?.authorization || '');
        return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    }

    /**
     * Open a request an operator approves in a browser.
     *
     * A stale credential is not an error: the binding may have been revoked, or
     * this server rebuilt from a store that never held it, so the socket is
     * offered a fresh request instead of a dead end.
     * @param hello - the runtime's registration frame.
     * @param staleToken - whether the runtime presented a credential we do not know.
     */
    private async beginPairing(hello: RuntimeHelloFrame, staleToken: boolean): Promise<void> {
        const pairSecret = String(hello.pairSecret || '');
        if (pairSecret === '') {
            this.sendFrame({ key: 'hello', accepted: false, reason: 'the runtime presented neither a valid token nor a pairing secret' });
            this.close(4001, 'nothing to pair with');
            return;
        }
        const host = String(hello.host || this.request.ip || 'remote');
        const { code, expiresAt } = await AgentLinkModel.request({
            label: String(hello.label || `${host}#${hello.pid ?? 0}`),
            host,
            pid: Number(hello.pid) || 0,
            pairSecret,
        });
        this.pairing = { code, pairSecret };
        const origin = `http://${String(this.request.headers?.host || SystemModel.get('server.url') || '127.0.0.1:2333')}`;
        this.sendFrame({
            key: 'pairing',
            code,
            url: `${origin}/agent-link/${code}`,
            expiresAt,
            ...staleToken ? { staleToken: true as const } : {},
        });
        logger.info('Agent runtime %s asks to be bound: %s/agent-link/%s', host, origin, code);
    }

    /**
     * Answer one poll from a socket waiting to be bound.
     * @param frame - the poll, carrying the request code and the socket's secret.
     */
    private async answerLinkPoll(frame: RuntimeLinkPollFrame): Promise<void> {
        if (this.pairing !== null && this.pairing.code === frame.code && this.pairing.pairSecret !== frame.pairSecret) {
            this.sendFrame({ key: 'link', error: 'link request belongs to another connection' });
            return;
        }
        const state = await AgentLinkModel.poll(frame.code, frame.pairSecret);
        if ('error' in state) {
            this.sendFrame({ key: 'link', error: state.error });
            return;
        }
        if (state.status === 'approved' && state.token !== undefined) {
            this.sendFrame({ key: 'link', status: 'approved', token: state.token });
            this.pairing = null;
            return;
        }
        this.sendFrame({ key: 'link', status: 'pending' });
    }

    /**
     * Register one runtime as a served runtime.
     *
     * The identity comes from the runtime's own host and pid — the same rule the
     * embedded runtime's row uses — so a page reads one kind of row whatever
     * transport a runtime arrived on.
     * @param hello - the runtime's registration frame.
     * @param label - the label its binding carries, which is what it was approved as.
     */
    private async serve(hello: RuntimeHelloFrame, binding: { code: string; label: string }): Promise<void> {
        // The identity is the code an operator saw and approved, not the process
        // serving it: a restart must reach the same row and the same approved name
        // must mean the same runtime. Only this server's own record supplies it —
        // a runtime that stated its own id could claim another's.
        const id = binding.code;
        this.runtimeIdValue = id;
        rememberRuntime(id, {
            label: binding.label,
            host: String(hello.host || this.request.ip || 'remote'),
            pid: Number(hello.pid) || 0,
            startedAt: Number(hello.startedAt) || Date.now(),
        });
        const link = createSocketLink(id, {
            send: (frame) => this.sendFrame(frame),
            onFrame: (listener) => { this.frameListeners.push(listener); },
            onClose: (listener) => { this.closeListeners.push(listener); },
        });
        this.link = link;
        // A runtime that reconnects under an identity a live connection still
        // holds would make routing ambiguous: the older socket loses.
        runtimeLinks.get(id)?.dispose();
        addLink(link);
        this.sendFrame({ key: 'hello', accepted: true, runtimeId: id });
        logger.info('Agent runtime connected id=%s remote=%s label=%s', id, this.request.ip || 'unknown', binding.label);
        try {
            // The facts only the runtime knows (version, working directory, how
            // much work it holds) come from the runtime: a row that never asked
            // would carry an identity and nothing else.
            await reportRuntime(link);
        } catch (error) {
            logger.warn('Agent runtime %s did not answer host.describe: %o', id, error);
        }
    }

    /** Drop this connection's link and record that the runtime is no longer here. */
    private async release(): Promise<void> {
        this.pairing = null;
        if (this.identifyTimer) {
            clearTimeout(this.identifyTimer);
            this.identifyTimer = null;
        }
        const link = this.link;
        this.link = null;
        if (link === null) return;
        link.dispose();
        if (this.runtimeIdValue && runtimeLinks.get(this.runtimeIdValue) === link) {
            runtimeLinks.delete(this.runtimeIdValue);
            runtimeFacts.delete(this.runtimeIdValue);
            try {
                await agentDataAdapter.markRuntimeOffline(this.runtimeIdValue);
            } catch (error) {
                logger.warn('Agent runtime offline record failed: %o', error);
            }
        }
        for (const listener of this.closeListeners.slice()) listener();
        logger.info('Agent runtime disconnected id=%s', this.runtimeIdValue || '(unidentified)');
    }
}


export async function apply(ctx: Context): Promise<void> {
    ctx.Route('agent_domain', '/agent', EjunzAgentPageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ejunz_agent_status', '/agent/status', EjunzAgentStatusPageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ejunz_agent_link', '/agent-link/:code', EjunzAgentLinkPageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ejunz_agent_data', '/api/ejunz-agent/data/*method', EjunzAgentDataHandler);
    ctx.Route('ejunz_agent_rpc', '/api/ejunz-agent/rpc/*method', EjunzAgentRpcHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ejunz_agent_response', '/api/ejunz-agent/respond', EjunzAgentResponseHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ejunz_agent_sse', '/api/ejunz-agent/sse/plugins/events', EjunzAgentSseHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('ejunz_agent_events', '/api/ejunz-agent/events/:stream', EjunzAgentEventsConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('ejunz_agent_runtime', '/api/ejunz-agent/runtime', EjunzAgentRuntimeConnectionHandler);
}
