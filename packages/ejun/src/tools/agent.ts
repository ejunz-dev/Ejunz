import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV, PERM } from 'ejun/src/model/builtin';
import AgentDefinitionModel, { AgentSessionModel } from 'ejun/src/model/agent';
import UserModel from 'ejun/src/model/user';
import { MAX_CARDS_PER_CALL, MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT, MAX_NODES_PER_CALL } from '../lib/tool-limits';
import { asText, idList } from '../lib/tool-shared';
import { agentRuntimeHandlerContext } from '../service/runtime';
import type { AgentNodeDoc, AgentSessionSummary } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const List = Schema.object({
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('List Agent definitions available in the current domain. Each result includes its id, title, description, update time, and the current user’s node and session-card counts.');

export const Search = Schema.object({
    query: Schema.string().required().description('Search text.'),
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('Search Agent definitions in the current domain by title or description.');

export const Get = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
}).description('Read an Agent definition by agentId. Returns its id, title, description, update time, and a tree of the current user’s workspace nodes and session cards.');

export const Create = Schema.object({
    title: Schema.string().required().description('Agent name (required, up to 256 characters).'),
    content: Schema.string().description('Agent description or instructions (optional, up to 100000 characters).'),
}).description('Create an Agent definition in the current domain. The current user owns the new Agent and its workspace root node.');

export const Update = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    title: Schema.string().description('New Agent name (optional).'),
    content: Schema.string().description('New Agent description or instructions (optional).'),
}).description('Update an Agent definition by agentId. Only the owner or a user with edit-discussion permission can update another user’s Agent.');

export const Remove = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
}).description('Delete an Agent definition by agentId. Existing sessions and workspace nodes are detached, as in the Agent management UI.');

export const NodeList = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
}).description('List the current user’s workspace nodes for an Agent, including its root node.');

export const NodeGet = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeId: Schema.string().required().description('Node id.'),
}).description('Read one workspace node belonging to an Agent, including its direct child nodes and the session cards attached to it.');

export const NodeCreate = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    text: Schema.string().required().description('Node title.'),
    parentId: Schema.string().description('Existing parent node id (optional; defaults to the Agent root).'),
}).description('Create a workspace node for an Agent. Omit parentId to place it under the Agent root.');

export const NodeUpdate = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeId: Schema.string().required().description('Node id.'),
    text: Schema.string().required().description('New node title.'),
    parentId: Schema.string().description('Existing parent node id (optional; omit to keep the current parent).'),
}).description('Rename and/or move a workspace node belonging to an Agent. Pass parentId to move it under an existing node. The root node cannot be renamed or moved.');

export const NodeRemove = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeId: Schema.string().required().description('Node id.'),
}).description('Delete a workspace node belonging to an Agent. Its child nodes and session cards move to its parent. The root node cannot be deleted.');

export const NodeCreateMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    parentId: Schema.string().description('Node that every entry without a parent attaches to (optional; defaults to the Agent root).'),
    nodes: Schema.array(Schema.object({
        text: Schema.string().required().description('Node title (required).'),
        ref: Schema.string().description('Optional name for this entry, for a later entry\'s parentRef.'),
        parentId: Schema.string().description('Existing node to attach to (optional).'),
        parentRef: Schema.string().description('ref of an earlier entry to attach to (optional; keep one of parentId and parentRef).'),
    })).min(1).max(MAX_NODES_PER_CALL).required().description('Nodes to create, in order.'),
}).description('Create several workspace nodes for one Agent. `nodes` is an array of `{ text, ref?, parentId?, parentRef? }`. '
    + 'A `ref` names an entry so a later entry can use it as its `parentRef`. An entry with neither parent attaches to the call\'s `parentId`, or to the Agent root. '
    + `One call creates at most ${MAX_NODES_PER_CALL} nodes.`);

export const NodeGetMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeIds: Schema.array(Schema.string()).min(1).max(MAX_NODES_PER_CALL).required().description('Node ids to read, in order.'),
}).description('Read several workspace nodes of one Agent, each with its direct child nodes and session cards. '
    + `A missing id is listed in \`missingNodeIds\` and \`ok\` is false. One call reads at most ${MAX_NODES_PER_CALL} nodes.`);

export const NodeUpdateMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    entries: Schema.array(Schema.object({
        nodeId: Schema.string().required().description('Node to change (required).'),
        text: Schema.string().description('New node title (optional).'),
        parentId: Schema.string().description('Existing node to move this node under (optional).'),
    })).min(1).max(MAX_NODES_PER_CALL).required().description('One entry per node.'),
}).description('Rename and/or move several workspace nodes of one Agent. Each entry is `{ nodeId, text?, parentId? }` and must name at least one change. '
    + `The root node cannot be renamed or moved. One call updates at most ${MAX_NODES_PER_CALL} nodes.`);

export const NodeRemoveMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeIds: Schema.array(Schema.string()).min(1).max(MAX_NODES_PER_CALL).required().description('Nodes to remove.'),
}).description('Delete several workspace nodes of one Agent. Each node\'s children and session cards move to its parent, as `agent_node_delete` does. '
    + `The root node cannot be removed. One call removes at most ${MAX_NODES_PER_CALL} nodes.`);

export const CardList = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeId: Schema.string().description('Optional node id to filter sessions by their workspace node.'),
}).description('List this Agent’s session cards. Omit nodeId to list cards from every workspace node.');

const conversationRead = {
    beforeSeq: Schema.number().step(1).min(0).description('Return turns before this event seq. Omit it to read the latest turns.'),
    maxMessages: Schema.number().step(1).min(1).max(500).description('Maximum turns to read (default 50).'),
    maxChars: Schema.number().step(1).min(1).max(MAX_FILE_CONTENT_CHARS_LIMIT).description(`Cap on the returned text (default ${MAX_FILE_CONTENT_CHARS}).`),
};

export const CardGet = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    cardId: Schema.string().required().description('Session id shown as the card id in the Agent workspace.'),
    ...conversationRead,
}).description('Read one session card by cardId and return its title and conversation as `content`, the same way `base_card_get` returns a card body. '
    + 'Turns are the stored user and assistant messages, in order. The text stops at `maxChars` and `truncated` reports that. '
    + '`hasMore` means older turns remain. Pass the returned `beforeSeq` to read the previous page.');

export const CardCreate = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    nodeId: Schema.string().description('Optional existing workspace node id (defaults to the Agent root).'),
    title: Schema.string().description('Optional session card title.'),
    message: Schema.string().description('Optional first message. Omit it to create the card with its settings ready and start no conversation.'),
    provider: Schema.string().description('Optional model provider. Pass it together with model.'),
    model: Schema.string().description('Optional model id. Pass it together with provider.'),
    baseDocId: Schema.number().step(1).min(1).description('Optional Base to attach as this session\'s context.'),
    runtimeId: Schema.string().description('Optional host id. Omit it to use the default host.'),
    agentPreset: Schema.string().description('Optional Agent preset id.'),
}).description('Create a session card with its node, title, model, Base, host, and preset already set. '
    + 'Pass message to start the conversation after the card exists. Omit message to leave the card ready and silent. Requires an available Agent runtime.');

export const CardUpdate = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    cardId: Schema.string().required().description('Session id shown as the card id in the Agent workspace.'),
    title: Schema.string().description('New session card title (optional).'),
    nodeId: Schema.string().description('Move the session card to an existing workspace node (optional).'),
}).description('Rename or move a session card belonging to an Agent.');

export const CardRemove = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    cardId: Schema.string().required().description('Session id shown as the card id in the Agent workspace.'),
}).description('Delete a session card and its conversation history.');

const CardCreateFields = Schema.object({
    nodeId: Schema.string().description('Optional existing workspace node id (defaults to the Agent root).'),
    title: Schema.string().description('Optional session card title.'),
    message: Schema.string().description('Optional first message. Omit it to leave the card ready and silent.'),
    provider: Schema.string().description('Optional model provider. Pass it together with model.'),
    model: Schema.string().description('Optional model id. Pass it together with provider.'),
    baseDocId: Schema.number().step(1).min(1).description('Optional Base to attach as this session\'s context.'),
    runtimeId: Schema.string().description('Optional host id.'),
    agentPreset: Schema.string().description('Optional Agent preset id.'),
});

export const CardCreateMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    cards: Schema.array(CardCreateFields).min(1).max(MAX_CARDS_PER_CALL).required().description('Session cards to create, in order.'),
}).description('Create several session cards for one Agent. Each entry uses the same fields as `agent_sessionCard_create`. '
    + 'A card is stored before its optional message is sent, so a refused first message still leaves the card. '
    + `One call creates at most ${MAX_CARDS_PER_CALL} cards.`);

export const CardGetMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    cardIds: Schema.array(Schema.string()).min(1).max(MAX_CARDS_PER_CALL).required().description('Session card ids to read, in order.'),
    ...conversationRead,
}).description('Read several session cards of one Agent in a single call, each reported as `agent_sessionCard_get` reports one, including its conversation as `content`. '
    + 'A missing id is listed in `missingCardIds` and `ok` is false. '
    + `One call reads at most ${MAX_CARDS_PER_CALL} cards.`);

export const CardUpdateMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    entries: Schema.array(Schema.object({
        cardId: Schema.string().required().description('Session card id (required).'),
        title: Schema.string().description('New session card title (optional).'),
        nodeId: Schema.string().description('Existing workspace node to move the card to (optional).'),
    })).min(1).max(MAX_CARDS_PER_CALL).required().description('One entry per session card.'),
}).description('Rename and/or move several session cards of one Agent. Each entry is `{ cardId, title?, nodeId? }` and must name at least one change. '
    + `One call updates at most ${MAX_CARDS_PER_CALL} cards.`);

export const CardRemoveMany = Schema.object({
    agentId: Schema.number().step(1).min(1).required().description('Agent definition docId.'),
    cardIds: Schema.array(Schema.string()).min(1).max(MAX_CARDS_PER_CALL).required().description('Session cards to remove.'),
}).description('Delete several session cards of one Agent and their conversation history. '
    + `One call removes at most ${MAX_CARDS_PER_CALL} cards.`);

function agentIdOf(args: ToolArgs): number {
    const agentId = Number(args.agentId);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new Error('agentId is required');
    return agentId;
}

function agentView(agent: { docId: number; aid?: string; title?: string; content?: string; updateAt?: Date | string }) {
    return {
        agentId: Number(agent.docId),
        aid: String(agent.aid || ''),
        title: String(agent.title || ''),
        content: String(agent.content || ''),
        updateAt: agent.updateAt instanceof Date ? agent.updateAt.toISOString() : String(agent.updateAt || ''),
    };
}

function nodeView(node: AgentNodeDoc) {
    return {
        nodeId: node.nodeId,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.isRoot ? { isRoot: true } : {}),
        text: node.text,
        order: node.order,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
    };
}

type SessionCardData = Omit<AgentSessionSummary, 'createdAt'> & { createdAt?: number | Date };

function sessionTitleOf(session: SessionCardData): string {
    const title = session.projections?.values?.title;
    return typeof title === 'string' && title.trim()
        ? title
        : session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
}

function sessionCardView(session: SessionCardData) {
    return {
        cardId: session.sessionId,
        sessionId: session.sessionId,
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        ...(session.nodeId === undefined ? {} : { nodeId: session.nodeId }),
        title: sessionTitleOf(session),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        cardType: 'session',
        createdAt: session.createdAt instanceof Date ? session.createdAt.getTime() : session.createdAt ?? null,
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        ...(session.model === undefined ? {} : { model: session.model }),
        ...(session.baseDocId === undefined ? {} : { baseDocId: session.baseDocId }),
    };
}

async function requireAgent(ctx: ToolContext, args: ToolArgs, action: 'read' | 'edit' | 'delete' = 'read') {
    const agentId = agentIdOf(args);
    const agent = await AgentDefinitionModel.get(ctx.domainId, agentId, AgentDefinitionModel.PROJECTION_LIST);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (action !== 'read' && Number(agent.owner) !== Number(ctx.owner)) {
        const user = await UserModel.getById(ctx.domainId, ctx.owner);
        const permission = action === 'delete' ? PERM.PERM_DELETE_DISCUSSION : PERM.PERM_EDIT_DISCUSSION;
        if (!user.hasPerm(permission)) throw new Error(`You do not have permission to ${action} this Agent`);
    }
    return { agentId, agent };
}

async function ensureAgentRoot(ctx: ToolContext, agentId: number, title: string) {
    return await AgentSessionModel.ensureAgentRoot(ctx.domainId, ctx.owner, agentId, title);
}

function resultLimit(raw: unknown): number {
    return Math.max(1, Math.min(50, Number(raw) || 15));
}

interface OutlineEntry {
    type: 'node' | 'card';
    id: string;
    title: string;
    children?: OutlineEntry[];
}

function buildOutline(nodeList: AgentNodeDoc[], sessions: AgentSessionSummary[]): OutlineEntry[] {
    const ids = new Set(nodeList.map((node) => node.nodeId));
    const childrenByParent = new Map<string, AgentNodeDoc[]>();
    for (const node of nodeList) {
        if (!node.parentId || !ids.has(node.parentId)) continue;
        const children = childrenByParent.get(node.parentId);
        if (children) children.push(node);
        else childrenByParent.set(node.parentId, [node]);
    }
    const cardsByNode = new Map<string, AgentSessionSummary[]>();
    const loose: AgentSessionSummary[] = [];
    for (const session of sessions) {
        if (session.nodeId && ids.has(session.nodeId)) {
            const cards = cardsByNode.get(session.nodeId);
            if (cards) cards.push(session);
            else cardsByNode.set(session.nodeId, [session]);
        } else loose.push(session);
    }
    const render = (node: AgentNodeDoc): OutlineEntry => ({
        type: 'node',
        id: node.nodeId,
        title: node.text,
        children: [
            ...(cardsByNode.get(node.nodeId) || []).map((session) => ({ type: 'card' as const, id: session.sessionId, title: sessionTitleOf(session) })),
            ...(childrenByParent.get(node.nodeId) || []).map(render),
        ],
    });
    return [
        ...nodeList.filter((node) => !node.parentId || !ids.has(node.parentId)).map(render),
        ...loose.map((session) => ({ type: 'card' as const, id: session.sessionId, title: sessionTitleOf(session) })),
    ];
}

function nodeDetail(node: AgentNodeDoc, nodes: AgentNodeDoc[], sessions: AgentSessionSummary[]) {
    return {
        node: nodeView(node),
        childNodes: nodes
            .filter((child) => child.parentId === node.nodeId)
            .map((child) => ({ nodeId: child.nodeId, title: child.text })),
        cards: sessions.filter((session) => session.nodeId === node.nodeId).map(sessionCardView),
    };
}

async function agentWorkspace(ctx: ToolContext, agentId: number) {
    const [nodes, sessions] = await Promise.all([
        AgentSessionModel.listNodes(ctx.domainId, ctx.owner, agentId),
        AgentSessionModel.listSessions(ctx.domainId, ctx.owner, agentId),
    ]);
    return { nodes, sessions };
}

export async function list(ctx: ToolContext, args: ToolArgs) {
    const limit = resultLimit(args.limit);
    const agents = (await AgentDefinitionModel.getMulti(ctx.domainId).toArray()).slice(0, limit);
    const listed = await Promise.all(agents.map(async (agent) => {
        const workspace = await agentWorkspace(ctx, agent.docId);
        return { ...agentView(agent), nodeCount: workspace.nodes.length, cardCount: workspace.sessions.length };
    }));
    return { ok: true, count: listed.length, agents: listed };
}

export async function search(ctx: ToolContext, args: ToolArgs) {
    const query = String(args.query || '').trim().toLowerCase();
    if (!query) throw new Error('query is required');
    const limit = resultLimit(args.limit);
    const agents = await AgentDefinitionModel.getMulti(ctx.domainId).toArray();
    const matches = agents.filter((agent) => [agent.title, agent.content].some((value) => typeof value === 'string' && value.toLowerCase().includes(query)));
    return {
        ok: true,
        query,
        count: Math.min(matches.length, limit),
        agents: matches.slice(0, limit).map(agentView),
    };
}

export async function get(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args);
    await ensureAgentRoot(ctx, agentId, agent.title);
    const workspace = await agentWorkspace(ctx, agentId);
    return {
        ok: true,
        agent: agentView(agent),
        nodeCount: workspace.nodes.length,
        cardCount: workspace.sessions.length,
        outline: buildOutline(workspace.nodes, workspace.sessions),
    };
}

export async function create(ctx: ToolContext, args: ToolArgs) {
    const title = String(args.title || '').trim();
    const content = typeof args.content === 'string' ? args.content : '';
    if (!title || title.length > 256) throw new Error('title is required and must be at most 256 characters');
    if (content.length > 100000) throw new Error('content must be at most 100000 characters');
    const aid = await AgentDefinitionModel.add(ctx.domainId, ctx.owner, title, content);
    const agent = await AgentDefinitionModel.get(ctx.domainId, aid, AgentDefinitionModel.PROJECTION_LIST);
    if (!agent) throw new Error('Failed to read the created Agent');
    await ensureAgentRoot(ctx, agent.docId, agent.title);
    return { ok: true, agent: agentView(agent) };
}

export async function update(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args, 'edit');
    const updates: Record<string, string> = {};
    if (Object.prototype.hasOwnProperty.call(args, 'title')) {
        const title = String(args.title || '').trim();
        if (!title || title.length > 256) throw new Error('title must be between 1 and 256 characters');
        updates.title = title;
    }
    if (typeof args.content === 'string') {
        if (args.content.length > 100000) throw new Error('content must be at most 100000 characters');
        updates.content = args.content;
    }
    if (!Object.keys(updates).length) throw new Error('Nothing to update');
    const agent = await AgentDefinitionModel.edit(ctx.domainId, agentId, updates);
    if (updates.title !== undefined) await AgentSessionModel.syncAgentRootTitle(ctx.domainId, agentId, updates.title);
    return { ok: true, agent: agentView(agent) };
}

export async function remove(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args, 'delete');
    await AgentSessionModel.detachAgent(ctx.domainId, agentId);
    await AgentDefinitionModel.del(ctx.domainId, agentId);
    return { ok: true, agentId, deleted: true };
}

export async function listNodes(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args);
    await ensureAgentRoot(ctx, agentId, agent.title);
    const nodes = await AgentSessionModel.listNodes(ctx.domainId, ctx.owner, agentId);
    return { ok: true, agentId, count: nodes.length, nodes: nodes.map(nodeView) };
}

export async function getNode(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args);
    await ensureAgentRoot(ctx, agentId, agent.title);
    const nodeId = String(args.nodeId || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    const node = await AgentSessionModel.getNode(ctx.domainId, ctx.owner, nodeId, agentId);
    if (!node) throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
    const workspace = await agentWorkspace(ctx, agentId);
    return { ok: true, agentId, ...nodeDetail(node, workspace.nodes, workspace.sessions) };
}

export async function createNode(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    await ensureAgentRoot(ctx, agentId, agent.title);
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required');
    const parentId = typeof args.parentId === 'string' && args.parentId.trim() ? args.parentId.trim() : undefined;
    const node = await AgentSessionModel.createNode(ctx.domainId, ctx.owner, text, agentId, parentId);
    return { ok: true, agentId, node: nodeView(node) };
}

export async function updateNode(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    await ensureAgentRoot(ctx, agentId, agent.title);
    const nodeId = String(args.nodeId || '').trim();
    const text = String(args.text || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    if (!text) throw new Error('text is required');
    const hasParent = Object.prototype.hasOwnProperty.call(args, 'parentId');
    const parentId = hasParent ? asText(args.parentId) : undefined;
    if (hasParent && !parentId) throw new Error('parentId cannot be empty');
    const node = await AgentSessionModel.updateNode(ctx.domainId, ctx.owner, nodeId, text, agentId, parentId);
    if (!node) throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
    return { ok: true, agentId, node: nodeView(node) };
}

export async function removeNode(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    await ensureAgentRoot(ctx, agentId, agent.title);
    const nodeId = String(args.nodeId || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    const node = await AgentSessionModel.getNode(ctx.domainId, ctx.owner, nodeId, agentId);
    if (!node) throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
    await AgentSessionModel.deleteNode(ctx.domainId, ctx.owner, nodeId, agentId);
    return { ok: true, agentId, nodeId, deleted: true };
}

function sessionScope(ctx: ToolContext, agentId: number) {
    return { domainId: ctx.domainId, userId: ctx.owner, agentId };
}

async function renameSessionCard(ctx: ToolContext, agentId: number, sessionId: string, title: string) {
    const scope = sessionScope(ctx, agentId);
    const link = await agentRuntimeHandlerContext.linkForSession(scope, sessionId);
    const upstream = await agentRuntimeHandlerContext.callUpstream('session.rename', { sessionId, title }, link);
    if (!upstream.body.result?.ok) throw new Error(upstream.body.error?.message || 'Session rename failed');
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, agentId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await agentRuntimeHandlerContext.agentDataAdapter.updateSession(scope, sessionId, {
        projections: { values: { ...(session.projections?.values ?? {}), title } },
    });
}

export async function listCards(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args);
    const nodeId = typeof args.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined;
    if (nodeId && !await AgentSessionModel.getNode(ctx.domainId, ctx.owner, nodeId, agentId)) {
        throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
    }
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, agentId);
    const cards = nodeId ? sessions.filter((session) => session.nodeId === nodeId) : sessions;
    return { ok: true, agentId, ...(nodeId ? { nodeId } : {}), count: cards.length, cards: cards.map(sessionCardView) };
}

function messageText(event: Record<string, unknown>): string {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const nested = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {};
    const content = data.content ?? nested.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((block) => {
        if (!block || typeof block !== 'object') return '';
        const item = block as Record<string, unknown>;
        if (typeof item.text === 'string') return item.text;
        if (item.type === 'thinking' && typeof item.thinking === 'string') return item.thinking;
        if (item.type === 'input_text' && typeof item.input_text === 'string') return item.input_text;
        return '';
    }).filter(Boolean).join('');
}

function messageRole(event: Record<string, unknown>): 'user' | 'assistant' | 'context' {
    if (event.type === 'assistant/message') return 'assistant';
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const source = data.source && typeof data.source === 'object' ? data.source as Record<string, unknown> : {};
    return source.kind && source.kind !== 'user' ? 'context' : 'user';
}

function boundedCount(raw: unknown, label: string, max: number, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
    return value;
}

async function sessionConversation(ctx: ToolContext, agentId: number, sessionId: string, args: ToolArgs) {
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, agentId);
    if (!session) throw new Error(`Session card not found in Agent ${agentId}: ${sessionId}`);
    const maxMessages = boundedCount(args.maxMessages, 'maxMessages', 500, 50);
    const maxChars = boundedCount(args.maxChars, 'maxChars', MAX_FILE_CONTENT_CHARS_LIMIT, MAX_FILE_CONTENT_CHARS);
    const beforeSeq = args.beforeSeq === undefined || args.beforeSeq === null || args.beforeSeq === '' ? undefined : Number(args.beforeSeq);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new Error('beforeSeq must be a non-negative integer');
    const page = await AgentSessionModel.listMessageEvents(ctx.domainId, ctx.owner, sessionId, beforeSeq, maxMessages, agentId);
    const turns = page.events.flatMap((event) => {
        const text = messageText(event);
        if (!text) return [];
        return [{ seq: Number(event.seq), role: messageRole(event), text }];
    });
    let kept = turns;
    let content = kept.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n');
    let truncated = false;
    while (kept.length > 1 && content.length > maxChars) {
        kept = kept.slice(1);
        content = kept.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n');
        truncated = true;
    }
    if (content.length > maxChars) {
        content = content.slice(content.length - maxChars);
        truncated = true;
    }
    return {
        ...sessionCardView(session),
        content,
        textLength: content.length,
        truncated,
        hasMore: page.hasMore || kept.length < turns.length,
        ...(kept[0] ? { beforeSeq: kept[0].seq } : {}),
    };
}

export async function getCard(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args);
    const sessionId = String(args.cardId || '').trim();
    if (!sessionId) throw new Error('cardId/sessionId is required');
    const card = await sessionConversation(ctx, agentId, sessionId, args);
    return { ok: true, agentId, ...card };
}

interface SessionCardCreateInput {
    nodeId?: string;
    title?: string;
    message?: string;
    provider?: string;
    model?: string;
    baseDocId?: number;
    runtimeId?: string;
    agentPreset?: string;
}

function sessionCardInput(fields: Record<string, unknown>, label = ''): SessionCardCreateInput {
    const prefix = label ? `${label}.` : '';
    const provider = asText(fields.provider);
    const model = asText(fields.model);
    if (Boolean(provider) !== Boolean(model)) throw new Error(`${prefix}provider and model must be passed together`);
    let baseDocId: number | undefined;
    if (fields.baseDocId !== undefined && fields.baseDocId !== null && fields.baseDocId !== '') {
        const numeric = Number(fields.baseDocId);
        if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`${prefix}baseDocId must be a positive integer`);
        baseDocId = numeric;
    }
    const title = typeof fields.title === 'string' ? fields.title.trim() : '';
    const message = typeof fields.message === 'string' ? fields.message.trim() : '';
    return {
        ...(asText(fields.nodeId) ? { nodeId: asText(fields.nodeId) } : {}),
        ...(title ? { title } : {}),
        ...(message ? { message } : {}),
        ...(provider ? { provider, model } : {}),
        ...(baseDocId === undefined ? {} : { baseDocId }),
        ...(asText(fields.runtimeId) ? { runtimeId: asText(fields.runtimeId) } : {}),
        ...(asText(fields.agentPreset) ? { agentPreset: asText(fields.agentPreset) } : {}),
    };
}

async function createSessionCard(ctx: ToolContext, agentId: number, agentTitle: string, input: SessionCardCreateInput) {
    const root = await ensureAgentRoot(ctx, agentId, agentTitle);
    const nodeId = input.nodeId || root.nodeId;
    if (!await AgentSessionModel.getNode(ctx.domainId, ctx.owner, nodeId, agentId)) {
        throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
    }
    const scope = sessionScope(ctx, agentId);
    const payload: Record<string, unknown> = {
        nodeId,
        ...(input.provider && input.model ? { provider: input.provider, model: input.model } : {}),
        ...(input.baseDocId === undefined ? {} : { baseDocId: input.baseDocId }),
        ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
        ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
    };
    const created = await agentRuntimeHandlerContext.sessionCreate({ payload }, scope);
    if (!created.result?.ok) throw new Error(created.error?.message || 'Failed to create Agent session');
    const value = created.result.value as { sessionId?: string } | undefined;
    const sessionId = value?.sessionId;
    if (!sessionId) throw new Error('Session creation returned no sessionId');
    if (input.title) await renameSessionCard(ctx, agentId, sessionId, input.title);
    let started = false;
    let error: string | undefined;
    if (input.message) {
        try {
            const link = await agentRuntimeHandlerContext.linkForSession(scope, sessionId);
            const upstream = await agentRuntimeHandlerContext.callUpstream('session.prompt', {
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: input.message }],
            }, link);
            if (!upstream.body.result?.ok) throw new Error(upstream.body.error?.message || 'Failed to start the conversation');
            started = true;
        } catch (caught) {
            error = (caught as Error).message;
        }
    }
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, agentId);
    if (!session) throw new Error(`Created session not found: ${sessionId}`);
    return { card: sessionCardView(session), started, ...(error ? { error } : {}) };
}

function objectEntries(raw: unknown, label: string): Record<string, unknown>[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error(`${label} must be a non-empty array`);
    return raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}[${index}] must be an object`);
        return entry as Record<string, unknown>;
    });
}

export async function createCard(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    const created = await createSessionCard(ctx, agentId, agent.title, sessionCardInput(args));
    return {
        ok: created.error === undefined,
        agentId,
        started: created.started,
        card: created.card,
        ...(created.error ? { error: created.error } : {}),
    };
}

export async function updateCard(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args, 'edit');
    const sessionId = String(args.cardId || '').trim();
    if (!sessionId) throw new Error('cardId/sessionId is required');
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, agentId);
    if (!session) throw new Error(`Session card not found in Agent ${agentId}: ${sessionId}`);
    const title = typeof args.title === 'string' ? args.title.trim() : undefined;
    if (title === '') throw new Error('title cannot be empty');
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : undefined;
    if (nodeId !== undefined) {
        if (!nodeId) throw new Error('nodeId cannot be empty');
        if (!await AgentSessionModel.getNode(ctx.domainId, ctx.owner, nodeId, agentId)) {
            throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
        }
    }
    if (title === undefined && nodeId === undefined) throw new Error('Nothing to update (title or nodeId required)');
    if (title !== undefined) await renameSessionCard(ctx, agentId, sessionId, title);
    if (nodeId !== undefined) {
        await agentRuntimeHandlerContext.agentDataAdapter.updateSession(sessionScope(ctx, agentId), sessionId, { nodeId });
    }
    const updated = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, agentId);
    if (!updated) throw new Error(`Session card not found in Agent ${agentId}: ${sessionId}`);
    return { ok: true, agentId, card: sessionCardView(updated) };
}

export async function createNodes(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    const root = await ensureAgentRoot(ctx, agentId, agent.title);
    const raw = objectEntries(args.nodes, 'nodes');
    if (raw.length > MAX_NODES_PER_CALL) throw new Error(`nodes holds ${raw.length} entries and one call creates ${MAX_NODES_PER_CALL}; split the work across calls`);
    const existing = await AgentSessionModel.listNodes(ctx.domainId, ctx.owner, agentId);
    const known = new Set(existing.map((node) => node.nodeId));
    const defaultParent = asText(args.parentId) || root.nodeId;
    if (!known.has(defaultParent)) throw new Error(`Parent node not found in Agent ${agentId}: ${defaultParent}`);
    const refIndex = new Map<string, number>();
    const planned: { index: number; text: string; ref: string; parentRef: string; parentId: string }[] = [];
    for (const [index, fields] of raw.entries()) {
        const text = asText(fields.text);
        if (!text) throw new Error(`nodes[${index}].text is required`);
        const ref = asText(fields.ref);
        if (ref && refIndex.has(ref)) throw new Error(`nodes[${index}].ref ${ref} is already the ref of nodes[${refIndex.get(ref)}]`);
        const parentRef = asText(fields.parentRef);
        const ownParent = asText(fields.parentId);
        if (parentRef && ownParent) throw new Error(`nodes[${index}] names both parentRef and parentId; keep one`);
        if (parentRef && !refIndex.has(parentRef)) throw new Error(`nodes[${index}].parentRef ${parentRef} does not name an earlier entry`);
        if (ownParent && !known.has(ownParent)) throw new Error(`nodes[${index}].parentId ${ownParent} is not a node of this Agent`);
        if (ref) refIndex.set(ref, index);
        planned.push({ index, text, ref, parentRef, parentId: ownParent });
    }
    const createdIds = new Map<number, string>();
    const created: { index: number; ref?: string; nodeId: string; parentId?: string; text: string }[] = [];
    const refused: { index: number; error: string }[] = [];
    for (const entry of planned) {
        const parentFromRef = entry.parentRef ? createdIds.get(refIndex.get(entry.parentRef) as number) : undefined;
        if (entry.parentRef && !parentFromRef) {
            refused.push({ index: entry.index, error: `Parent ref ${entry.parentRef} was not created` });
            continue;
        }
        const parentId = parentFromRef || entry.parentId || defaultParent;
        try {
            const node = await AgentSessionModel.createNode(ctx.domainId, ctx.owner, entry.text, agentId, parentId);
            createdIds.set(entry.index, node.nodeId);
            known.add(node.nodeId);
            created.push({ index: entry.index, ...(entry.ref ? { ref: entry.ref } : {}), nodeId: node.nodeId, parentId: node.parentId, text: node.text });
        } catch (error) {
            refused.push({ index: entry.index, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, agentId, nodeCount: created.length, nodes: created, refusedNodes: refused };
}

export async function getNodes(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args);
    await ensureAgentRoot(ctx, agentId, agent.title);
    const nodeIds = idList(args.nodeIds, 'nodeIds', MAX_NODES_PER_CALL);
    const workspace = await agentWorkspace(ctx, agentId);
    const byId = new Map(workspace.nodes.map((node) => [node.nodeId, node]));
    const found: { index: number; node: ReturnType<typeof nodeView>; childNodes: { nodeId: string; title: string }[]; cards: ReturnType<typeof sessionCardView>[] }[] = [];
    const missing: string[] = [];
    for (const [index, nodeId] of nodeIds.entries()) {
        const node = byId.get(nodeId);
        if (!node) {
            missing.push(nodeId);
            continue;
        }
        found.push({ index, ...nodeDetail(node, workspace.nodes, workspace.sessions) });
    }
    return { ok: missing.length === 0, agentId, nodeCount: found.length, nodes: found, missingNodeIds: missing };
}

export async function updateNodes(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    await ensureAgentRoot(ctx, agentId, agent.title);
    const raw = objectEntries(args.entries, 'entries');
    if (raw.length > MAX_NODES_PER_CALL) throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_NODES_PER_CALL}; split the work across calls`);
    const planned: { index: number; nodeId: string; text?: string; parentId?: string }[] = [];
    const seen = new Set<string>();
    for (const [index, fields] of raw.entries()) {
        const nodeId = asText(fields.nodeId);
        if (!nodeId) throw new Error(`entries[${index}].nodeId is required`);
        if (seen.has(nodeId)) throw new Error(`entries[${index}].nodeId ${nodeId} appears twice; send one entry per node`);
        seen.add(nodeId);
        const hasText = Object.prototype.hasOwnProperty.call(fields, 'text');
        const hasParent = Object.prototype.hasOwnProperty.call(fields, 'parentId');
        if (!hasText && !hasParent) throw new Error(`entries[${index}] names nothing to change; give text, parentId, or both`);
        const text = hasText ? asText(fields.text) : undefined;
        if (hasText && !text) throw new Error(`entries[${index}].text cannot be empty`);
        const parentId = hasParent ? asText(fields.parentId) : undefined;
        if (hasParent && !parentId) throw new Error(`entries[${index}].parentId cannot be empty`);
        planned.push({ index, nodeId, ...(text ? { text } : {}), ...(parentId ? { parentId } : {}) });
    }
    const currentNodes = await AgentSessionModel.listNodes(ctx.domainId, ctx.owner, agentId);
    const byId = new Map(currentNodes.map((node) => [node.nodeId, node]));
    for (const entry of planned) {
        const node = byId.get(entry.nodeId);
        if (!node) throw new Error(`Node not found in Agent ${agentId}: ${entry.nodeId}`);
        if (node.isRoot) throw new Error('Agent root node cannot be renamed or moved');
    }
    const updated: { index: number; node: ReturnType<typeof nodeView> }[] = [];
    const refused: { index: number; nodeId: string; error: string }[] = [];
    for (const entry of planned) {
        const current = await AgentSessionModel.getNode(ctx.domainId, ctx.owner, entry.nodeId, agentId);
        if (!current) {
            refused.push({ index: entry.index, nodeId: entry.nodeId, error: `Node not found in Agent ${agentId}: ${entry.nodeId}` });
            continue;
        }
        try {
            const node = await AgentSessionModel.updateNode(ctx.domainId, ctx.owner, entry.nodeId, entry.text ?? current.text, agentId, entry.parentId);
            if (!node) throw new Error(`Node not found in Agent ${agentId}: ${entry.nodeId}`);
            updated.push({ index: entry.index, node: nodeView(node) });
        } catch (error) {
            refused.push({ index: entry.index, nodeId: entry.nodeId, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, agentId, nodeCount: updated.length, nodes: updated, refusedNodes: refused };
}

export async function removeNodes(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    await ensureAgentRoot(ctx, agentId, agent.title);
    const nodeIds = idList(args.nodeIds, 'nodeIds', MAX_NODES_PER_CALL);
    const currentNodes = await AgentSessionModel.listNodes(ctx.domainId, ctx.owner, agentId);
    const byId = new Map(currentNodes.map((node) => [node.nodeId, node]));
    for (const nodeId of nodeIds) {
        const node = byId.get(nodeId);
        if (!node) throw new Error(`Node not found in Agent ${agentId}: ${nodeId}`);
        if (node.isRoot) throw new Error('Agent root node cannot be deleted');
    }
    for (const nodeId of nodeIds) await AgentSessionModel.deleteNode(ctx.domainId, ctx.owner, nodeId, agentId);
    return { ok: true, agentId, removedNodeIds: nodeIds, removedCount: nodeIds.length };
}

export async function createCards(ctx: ToolContext, args: ToolArgs) {
    const { agentId, agent } = await requireAgent(ctx, args, 'edit');
    const raw = objectEntries(args.cards, 'cards');
    if (raw.length > MAX_CARDS_PER_CALL) throw new Error(`cards holds ${raw.length} entries and one call creates ${MAX_CARDS_PER_CALL}; split the work across calls`);
    const planned = raw.map((fields, index) => sessionCardInput(fields, `cards[${index}]`));
    const created: { index: number; started: boolean; card: ReturnType<typeof sessionCardView>; error?: string }[] = [];
    const refused: { index: number; cardId?: string; error: string }[] = [];
    for (const [index, input] of planned.entries()) {
        try {
            const result = await createSessionCard(ctx, agentId, agent.title, input);
            created.push({ index, started: result.started, card: result.card, ...(result.error ? { error: result.error } : {}) });
            if (result.error) refused.push({ index, cardId: result.card.cardId, error: result.error });
        } catch (error) {
            refused.push({ index, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, agentId, cardCount: created.length, cards: created, refusedCards: refused };
}

export async function getCards(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args);
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, agentId);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const found: { index: number; cardId: string; title: string; content: string; hasMore?: boolean; beforeSeq?: number; truncated?: boolean }[] = [];
    const missing: string[] = [];
    for (const [index, cardId] of cardIds.entries()) {
        const session = byId.get(cardId);
        if (!session) {
            missing.push(cardId);
            continue;
        }
        const card = await sessionConversation(ctx, agentId, cardId, args);
        found.push({
            index,
            cardId: card.cardId,
            title: card.title,
            content: card.content,
            ...(card.hasMore ? { hasMore: true, beforeSeq: card.beforeSeq } : {}),
            ...(card.truncated ? { truncated: true } : {}),
        });
    }
    return { ok: missing.length === 0, agentId, cardCount: found.length, cards: found, missingCardIds: missing };
}

export async function updateCards(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args, 'edit');
    const raw = objectEntries(args.entries, 'entries');
    if (raw.length > MAX_CARDS_PER_CALL) throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_CARDS_PER_CALL}; split the work across calls`);
    const planned: { index: number; cardId: string; title?: string; nodeId?: string }[] = [];
    const seen = new Set<string>();
    for (const [index, fields] of raw.entries()) {
        const cardId = asText(fields.cardId);
        if (!cardId) throw new Error(`entries[${index}].cardId is required`);
        if (seen.has(cardId)) throw new Error(`entries[${index}].cardId ${cardId} appears twice; send one entry per card`);
        seen.add(cardId);
        const hasTitle = Object.prototype.hasOwnProperty.call(fields, 'title');
        const hasNode = Object.prototype.hasOwnProperty.call(fields, 'nodeId');
        if (!hasTitle && !hasNode) throw new Error(`entries[${index}] names nothing to change; give title, nodeId, or both`);
        const title = hasTitle ? asText(fields.title) : undefined;
        if (hasTitle && !title) throw new Error(`entries[${index}].title cannot be empty`);
        const nodeId = hasNode ? asText(fields.nodeId) : undefined;
        if (hasNode && !nodeId) throw new Error(`entries[${index}].nodeId cannot be empty`);
        planned.push({ index, cardId, ...(title ? { title } : {}), ...(nodeId ? { nodeId } : {}) });
    }
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, agentId);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    for (const entry of planned) {
        if (!byId.has(entry.cardId)) throw new Error(`Session card not found in Agent ${agentId}: ${entry.cardId}`);
        if (entry.nodeId && !await AgentSessionModel.getNode(ctx.domainId, ctx.owner, entry.nodeId, agentId)) {
            throw new Error(`Node not found in Agent ${agentId}: ${entry.nodeId}`);
        }
    }
    const updated: { index: number; card: ReturnType<typeof sessionCardView> }[] = [];
    const refused: { index: number; cardId: string; error: string }[] = [];
    for (const entry of planned) {
        try {
            if (entry.title) await renameSessionCard(ctx, agentId, entry.cardId, entry.title);
            if (entry.nodeId) await agentRuntimeHandlerContext.agentDataAdapter.updateSession(sessionScope(ctx, agentId), entry.cardId, { nodeId: entry.nodeId });
            const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, entry.cardId, agentId);
            if (!session) throw new Error(`Session card not found in Agent ${agentId}: ${entry.cardId}`);
            updated.push({ index: entry.index, card: sessionCardView(session) });
        } catch (error) {
            refused.push({ index: entry.index, cardId: entry.cardId, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, agentId, cardCount: updated.length, cards: updated, refusedCards: refused };
}

export async function removeCards(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args, 'delete');
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, agentId);
    const known = new Set(sessions.map((session) => session.sessionId));
    for (const cardId of cardIds) {
        if (!known.has(cardId)) throw new Error(`Session card not found in Agent ${agentId}: ${cardId}`);
    }
    await AgentSessionModel.deleteSessions(ctx.domainId, ctx.owner, cardIds, agentId);
    return { ok: true, agentId, removedCardIds: cardIds, removedCount: cardIds.length };
}

export async function removeCard(ctx: ToolContext, args: ToolArgs) {
    const { agentId } = await requireAgent(ctx, args, 'delete');
    const sessionId = String(args.cardId || '').trim();
    if (!sessionId) throw new Error('cardId/sessionId is required');
    if (!await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, agentId)) {
        throw new Error(`Session card not found in Agent ${agentId}: ${sessionId}`);
    }
    await AgentSessionModel.deleteSession(ctx.domainId, ctx.owner, sessionId, agentId);
    return { ok: true, agentId, cardId: sessionId, deleted: true };
}

export function apply(ctx: Context) {
    const read = { source: 'agent', bindBase: 'none' as const };
    const write = { ...read, mutating: true };
    ctx.Tool('agent_list', list, List, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_search', search, Search, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_get', get, Get, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_create', create, Create, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_update', update, Update, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_delete', remove, Remove, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_list', listNodes, NodeList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_get', getNode, NodeGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_create', createNode, NodeCreate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_update', updateNode, NodeUpdate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_delete', removeNode, NodeRemove, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_create_many', createNodes, NodeCreateMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_get_many', getNodes, NodeGetMany, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_update_many', updateNodes, NodeUpdateMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_node_delete_many', removeNodes, NodeRemoveMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_list', listCards, CardList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_get', getCard, CardGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_create', createCard, CardCreate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_update', updateCard, CardUpdate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_delete', removeCard, CardRemove, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_create_many', createCards, CardCreateMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_get_many', getCards, CardGetMany, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_update_many', updateCards, CardUpdateMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent_sessionCard_delete_many', removeCards, CardRemoveMany, write, PRIV.PRIV_USER_PROFILE);
}
