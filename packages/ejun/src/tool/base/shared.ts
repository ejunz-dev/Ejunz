import { ObjectId } from 'mongodb';
import type { CardDoc, Problem, ProblemKind, BaseEdge, BaseNode } from '../../interface';
import { CardModel } from '../../model/base';
import { migrateRawProblem } from '../../model/problem';
import type { McpToolContext, ToolArgs } from '../types';
import type { McpBaseGitInput } from './git/types';

export function toObjectId(value: unknown): ObjectId {
    const s = String(value || '').trim();
    if (!ObjectId.isValid(s)) throw new Error(`Invalid cardId: ${s}`);
    return new ObjectId(s);
}

export async function requireCard(ctx: McpToolContext, cardId: unknown): Promise<CardDoc> {
    const card = await CardModel.get(ctx.domainId, toObjectId(cardId));
    if (!card) throw new Error('Card not found');
    if (String(card.baseDocId) !== String(ctx.baseDocId)) throw new Error('Card does not belong to this base');
    return card;
}

export function parseProblemPayload(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { }
    }
    throw new Error('problem must be a JSON object');
}

export function normalizeProblemKind(raw: unknown): ProblemKind | undefined {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return undefined;
    const kinds: ProblemKind[] = ['single', 'multi', 'true_false', 'flip', 'fill_blank', 'matching', 'super_flip', 'chain', 'ai_eval'];
    return kinds.includes(s as ProblemKind) ? s as ProblemKind : undefined;
}

export function buildProblemRaw(payload: Record<string, unknown>, pid: string): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...payload, pid };
    const kind = normalizeProblemKind(payload.type ?? payload.problemKind ?? payload.kind);
    if (kind) raw.type = kind;
    return raw;
}

export function newProblemPid(): string {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function problemPreview(problem: Problem): string {
    const type = (problem as Problem & { type?: string }).type || 'single';
    let text = '';
    if (type === 'flip') text = String((problem as { faceA?: string }).faceA || '');
    else if ('stem' in problem) text = String((problem as { stem?: string }).stem || '');
    else if (type === 'matching' || type === 'super_flip' || type === 'chain') {
        const columns = (problem as { columns?: string[][] }).columns;
        if (Array.isArray(columns) && columns[0]?.length) text = columns[0].join(' | ');
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

export function summarizeProblem(problem: Problem) {
    const type = (problem as Problem & { type?: string }).type || 'single';
    return { pid: problem.pid, type, title: problem.title || '', preview: problemPreview(problem), tags: Array.isArray(problem.tags) ? problem.tags : [] };
}

export async function saveCardProblems(domainId: string, card: CardDoc, problems: Problem[]): Promise<void> {
    await CardModel.update(domainId, card.docId, { problems });
}

export function findProblemIndex(problems: Problem[], pid: string): number {
    return problems.findIndex((problem) => String(problem.pid) === pid);
}

export function toMcpGitInput(ctx: McpToolContext, args: ToolArgs): McpBaseGitInput {
    return {
        domainId: ctx.domainId,
        baseDocId: ctx.baseDocId,
        owner: ctx.owner,
        setting: ctx.setting,
        githubToken: typeof args.githubToken === 'string' && args.githubToken.trim() ? args.githubToken.trim() : undefined,
        commitMessage: typeof args.commitMessage === 'string' ? args.commitMessage : undefined,
    };
}

export function buildParentMap(edges: BaseEdge[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const edge of edges || []) map.set(edge.target, edge.source);
    return map;
}

export function findRootNodeId(nodes: BaseNode[] = [], edges: BaseEdge[] = []): string | undefined {
    if (!nodes.length) return undefined;
    const levelRoot = nodes.find((node) => node.level === 0);
    if (levelRoot?.id) return levelRoot.id;
    const parentMap = buildParentMap(edges);
    return nodes.find((node) => !parentMap.has(node.id))?.id || nodes[0]?.id;
}

export function pathLabelFor(nodeId: string, parentMap: Map<string, string>, nodeById: Map<string, BaseNode>): string {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = nodeId;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = nodeById.get(current);
        chain.push((node?.text || '').trim() || 'Untitled');
        current = parentMap.get(current);
    }
    return chain.reverse().join(' › ');
}

