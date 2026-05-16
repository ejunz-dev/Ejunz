import { ObjectId } from 'mongodb';
import { Logger } from '../logger';
import { CardModel } from '../model/base';
import { hasActiveOutlineExplorerFilters } from '../model/base';
import type { BaseNode, BaseEdge, CardDoc } from '../interface';
import { fetchFilteredBaseOutline, outlineExplorerFiltersFromToolArgs } from './baseOutlineData';

const logger = new Logger('baseLoader');

/**
 * Prefix for links returned to the agent. Relative paths resolve against the *browser* origin
 * (e.g. qwen ask page), which yields wrong hosts — use system `server.url` when set.
 */
function getPublicOriginForBaseLinks(): string {
    try {
        const sys = (global as any).Ejunz?.model?.system;
        const url = sys?.get?.('server.url');
        if (typeof url === 'string' && url.length > 1 && url !== '/') {
            return url.replace(/\/+$/, '');
        }
    } catch {
        /* ignore */
    }
    return '';
}

function withOrigin(origin: string, path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    if (!origin) return p;
    return `${origin.replace(/\/+$/, '')}${p}`;
}

export interface ParsedCardNodeUrl {
    url: string;
    domainId?: string;
    docId?: string;
    branch?: string;
    nodeId?: string;
    cardId?: string;
    parseError?: string;
}

/**
 * Canonical outline page path (matches route `base_outline_doc_branch`).
 */
function outlineDocBranchPath(domainId: string, baseDocId: number, branch: string): string {
    return `/d/${encodeURIComponent(domainId)}/base/${baseDocId}/outline/branch/${encodeURIComponent(branch)}`;
}

/**
 * Parse a single outline card/node URL: only .../base/:baseDocId/outline/branch/:branch?nodeId= / ?cardId= .
 */
function parseCardNodeUrl(url: string): ParsedCardNodeUrl {
    const result: ParsedCardNodeUrl = { url: url.trim() };
    const raw = result.url;
    if (!raw) {
        result.parseError = 'empty url';
        return result;
    }
    try {
        const u = new URL(raw, 'http://localhost');
        const path = u.pathname.replace(/\/+$/, '');
        const segments = path.split('/').filter(Boolean);

        const cardId = u.searchParams.get('cardId') ?? undefined;
        const nodeIdParam = u.searchParams.get('nodeId') ?? undefined;
        if (cardId) result.cardId = cardId;
        if (nodeIdParam) result.nodeId = nodeIdParam;

        const dIdx = segments.indexOf('d');
        if (dIdx === -1 || segments.length < dIdx + 2) {
            result.parseError = 'path must contain /d/:domainId';
            return result;
        }
        result.domainId = segments[dIdx + 1];

        const baseIdx = segments.indexOf('base', dIdx + 2);
        if (baseIdx === -1) {
            result.parseError = 'path must contain base';
            return result;
        }

        const rest = segments.slice(baseIdx + 1);
        if (rest.length < 4 || rest[1] !== 'outline' || rest[2] !== 'branch' || !rest[3]) {
            result.parseError = 'path must be /d/:domainId/base/:baseDocId/outline/branch/:branch';
            return result;
        }

        result.docId = rest[0];
        result.branch = rest[3];

        return result;
    } catch (e) {
        result.parseError = e instanceof Error ? e.message : 'invalid url';
        return result;
    }
}

function buildNodeTree(nodes: BaseNode[], edges: BaseEdge[]): Map<string, BaseNode[]> {
    const childrenMap = new Map<string, BaseNode[]>();

    nodes.forEach(node => {
        const parentId = node.parentId ||
            (edges.find(e => e.target === node.id)?.source);

        if (parentId) {
            if (!childrenMap.has(parentId)) {
                childrenMap.set(parentId, []);
            }
            childrenMap.get(parentId)!.push(node);
        }
    });

    childrenMap.forEach((children) => {
        children.sort((a, b) => {
            if (a.level !== b.level) return (a.level || 0) - (b.level || 0);
            return (a.order || 0) - (b.order || 0);
        });
    });

    return childrenMap;
}

function cardUrl(origin: string, domainId: string, baseDocId: number, branch: string, _nodeId: string, cardId: ObjectId): string {
    return withOrigin(
        origin,
        `${outlineDocBranchPath(domainId, baseDocId, branch)}?cardId=${encodeURIComponent(String(cardId))}`,
    );
}

function nodeUrl(origin: string, domainId: string, baseDocId: number, branch: string, nodeId: string): string {
    const q = new URLSearchParams({ nodeId });
    return withOrigin(origin, `${outlineDocBranchPath(domainId, baseDocId, branch)}?${q.toString()}`);
}

function lessonCardUrl(origin: string, domainId: string, cardId: ObjectId): string {
    const q = new URLSearchParams({ cardId: String(cardId) });
    return withOrigin(origin, `/d/${encodeURIComponent(domainId)}/learn/lesson?${q.toString()}`);
}

function lessonNodeUrl(origin: string, domainId: string, nodeId: string): string {
    const q = new URLSearchParams({ nodeId });
    return withOrigin(origin, `/d/${encodeURIComponent(domainId)}/learn/lesson?${q.toString()}`);
}

async function loadBaseNodeRecursive(
    origin: string,
    domainId: string,
    baseDocId: number,
    branch: string,
    nodeId: string,
    nodes: BaseNode[],
    childrenMap: Map<string, BaseNode[]>,
    level: number = 0,
    maxLevel: number = -1
): Promise<string> {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return '';

    if (maxLevel >= 0 && level > maxLevel) {
        return '';
    }

    const indent = '  '.repeat(level);
    let content = '';
    const nodeLink = nodeUrl(origin, domainId, baseDocId, branch, nodeId);
    const nodeLessonLink = lessonNodeUrl(origin, domainId, nodeId);
    const nodeTitle = node.text || 'Untitled';

    if (level === 0) {
        // root: no heading, just recurse into children
    } else {
        const headingLevel = level === 1 ? 1 : Math.min(level + 1, 6);
        const headingMark = '#'.repeat(headingLevel);
        content += `\n${indent}${headingMark} [${nodeTitle}](${nodeLink}) [Lesson](${nodeLessonLink})\n\n`;

        if (maxLevel >= 0 && level === maxLevel) {
            const children = childrenMap.get(nodeId) || [];
            if (children.length > 0) {
                content += `${indent}**Child nodes:**\n`;
                for (const child of children) {
                    const childName = child.text || 'Untitled';
                    const childLink = nodeUrl(origin, domainId, baseDocId, branch, child.id);
                    const childLessonLink = lessonNodeUrl(origin, domainId, child.id);
                    content += `${indent}- [${childName}](${childLink}) [Lesson](${childLessonLink})\n`;
                }
                content += '\n';
            }
        }
    }

    if (maxLevel < 0 || level < maxLevel) {
        const children = childrenMap.get(nodeId) || [];
        for (const child of children) {
            content += await loadBaseNodeRecursive(
                origin,
                domainId,
                baseDocId,
                branch,
                child.id,
                nodes,
                childrenMap,
                level + 1,
                maxLevel
            );
        }
    }

    return content;
}

function cardIdsInMap(nodeCardsMap: Record<string, CardDoc[]>): Set<string> {
    const s = new Set<string>();
    for (const list of Object.values(nodeCardsMap)) {
        for (const c of list) {
            s.add(c.docId.toString());
        }
    }
    return s;
}

/**
 * Load base outline for the agent using the same filtering as the base data API (outline explorer).
 * maxLevel: 1=overview, 2+=depth, -1=full.
 */
export async function loadBaseInstructions(
    domainId: string,
    maxLevel: number = -1,
    branch?: string,
    baseDocId?: number,
    toolArgs?: Record<string, unknown>,
): Promise<string | null> {
    try {
        const filters = outlineExplorerFiltersFromToolArgs(toolArgs);
        const payload = await fetchFilteredBaseOutline(domainId, {
            baseDocId,
            branch,
            filters,
        });
        if (!payload) return null;

        const { nodes, edges, base, currentBranch, outlineExplorerFilters } = payload;
        if (nodes.length === 0) {
            if (hasActiveOutlineExplorerFilters(filters)) {
                return 'No nodes matched the outline filters (filterNode / filterCard / filterProblem). Try different keywords or omit filters.';
            }
            return null;
        }

        const childrenMap = buildNodeTree(nodes, edges);
        const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) && !edges.some(e => e.target === n.id));
        if (rootNodes.length === 0) return null;

        const rootNode = rootNodes[0];
        const linkOrigin = getPublicOriginForBaseLinks();
        const baseNumericId = Number((base as any).docId);
        const fullContent = await loadBaseNodeRecursive(
            linkOrigin,
            domainId,
            baseNumericId,
            currentBranch,
            rootNode.id,
            nodes,
            childrenMap,
            0,
            maxLevel
        );

        const filterLine = hasActiveOutlineExplorerFilters(outlineExplorerFilters)
            ? `Applied outline filters (same as base UI): filterNode="${outlineExplorerFilters.filterNode}" filterCard="${outlineExplorerFilters.filterCard}" filterProblem="${outlineExplorerFilters.filterProblem}".\n\n`
            : '';

        return fullContent
            ? `${filterLine}Below is the node structure (filtered like base/data). No card bodies here; call again with \`urls\` for one node/card link at a time.\n\n${fullContent}\n\n---\n\n`
            : null;
    } catch (e) {
        logger.warn('Failed to load base instructions:', e);
        return null;
    }
}

const INSTRUCTIONS_MAX_LENGTH = 12000;

/**
 * Load one node or card by URL, respecting the same outline filters as base/data.
 */
export async function loadBaseInstructionsByUrls(
    domainId: string,
    urls: string[],
    branch?: string,
    baseDocIdArg?: number,
    toolArgs?: Record<string, unknown>,
): Promise<string | null> {
    if (!urls || urls.length === 0) return null;
    try {
        const filters = outlineExplorerFiltersFromToolArgs(toolArgs);
        const payload = await fetchFilteredBaseOutline(domainId, {
            baseDocId: baseDocIdArg,
            branch,
            filters,
        });
        if (!payload) return null;

        const { nodes, base, currentBranch, outlineExplorerFilters, nodeCardsMap } = payload;
        const linkOrigin = getPublicOriginForBaseLinks();
        const baseNumericId = Number((base as any).docId);
        const visibleCardIds = cardIdsInMap(nodeCardsMap);

        const seenCardIds = new Set<string>();
        const parts: string[] = [];
        const oneUrlOnly = urls.length > 1 ? [urls[0]] : urls;
        const multiUrlNote = urls.length > 1 ? '\n(Only the first URL was loaded. Pass one node or one card URL per call and call again for more to avoid hanging.)\n\n' : '';

        for (const raw of oneUrlOnly) {
            const parsed = parseCardNodeUrl(typeof raw === 'string' ? raw : String(raw));
            if (parsed.parseError) {
                logger.debug('Skip invalid URL: %s (%s)', parsed.url, parsed.parseError);
                continue;
            }
            if (parsed.domainId && parsed.domainId !== domainId) {
                logger.debug('Skip URL from other domain: %s (expected %s)', parsed.domainId, domainId);
                continue;
            }
            if (Number(parsed.docId) !== baseNumericId) {
                logger.debug('Skip URL for other base doc: %s (expected %s)', parsed.docId, baseNumericId);
                continue;
            }

            if (parsed.cardId) {
                try {
                    const id = new ObjectId(parsed.cardId);
                    if (seenCardIds.has(id.toString())) continue;
                    if (hasActiveOutlineExplorerFilters(outlineExplorerFilters) && !visibleCardIds.has(id.toString())) {
                        parts.push(`\n\n(Card not in filtered outline; widen or clear filterCard/filterProblem/filterNode.)\n\n`);
                        continue;
                    }
                    const card = await CardModel.get(domainId, id);
                    if (!card || Number((card as any).baseDocId) !== Number((base as any).docId)) {
                        continue;
                    }
                    seenCardIds.add(id.toString());
                    const title = card.title || 'Untitled';
                    const body = (card.content || '').trim();
                    const nodeId = (card as any).nodeId;
                    const link = nodeId ? cardUrl(linkOrigin, domainId, baseNumericId, currentBranch, nodeId, card.docId) : '';
                    const lessonLink = lessonCardUrl(linkOrigin, domainId, card.docId);
                    parts.push(
                        link
                            ? `\n\n## [${title}](${link}) [Lesson](${lessonLink})\n\n${body}\n\n`
                            : `\n\n## [${title}](${lessonLink})\n\n${body}\n\n`
                    );
                } catch (e) {
                    logger.debug('Failed to load card %s: %s', parsed.cardId, (e as Error).message);
                }
                continue;
            }

            if (parsed.nodeId) {
                const node = nodes.find((n) => n.id === parsed.nodeId);
                if (!node && hasActiveOutlineExplorerFilters(outlineExplorerFilters)) {
                    parts.push('\n\n(Node not in filtered outline; widen or clear filters.)\n\n');
                    continue;
                }
                const nodeTitle = node?.text || 'Node';
                const nodeLink = nodeUrl(linkOrigin, domainId, baseNumericId, currentBranch, parsed.nodeId);
                const nodeLessonLink = lessonNodeUrl(linkOrigin, domainId, parsed.nodeId);
                const nodeCards = nodeCardsMap[parsed.nodeId] || [];
                const cardLines = nodeCards.map((card) => {
                    const title = card.title || 'Untitled';
                    const lessonLink = lessonCardUrl(linkOrigin, domainId, card.docId);
                    return `- [${title}](${lessonLink})`;
                });
                parts.push(
                    `\n\n**Node course URL (give this first when user asks for this node's course):** [${nodeTitle} – open lesson](${nodeLessonLink})\n\n` +
                    `## [${nodeTitle}](${nodeLink}) [Lesson](${nodeLessonLink})\n\n` +
                    (cardLines.length > 0 ? `Cards under this node (use these exact URLs; cardId must be the hex ID in the link, never the card title):\n${cardLines.join('\n')}\n\n` : '')
                );
            }
        }

        if (parts.length === 0) return null;
        const filterLine = hasActiveOutlineExplorerFilters(outlineExplorerFilters)
            ? `Outline filtering matches base/data API (filterNode / filterCard / filterProblem).\n\n`
            : '';
        let out = `Below is content for the given link (after filters). Use only URLs returned here. cardId must be the 24-char hex ID.\n\n${filterLine}${multiUrlNote}` + parts.join('');
        if (out.length > INSTRUCTIONS_MAX_LENGTH) {
            out = out.slice(0, INSTRUCTIONS_MAX_LENGTH) + `\n\n---\n(Content truncated, over ${INSTRUCTIONS_MAX_LENGTH} chars. Narrow urls or query by cardId alone.)`;
        }
        return out + '\n\n---\n\n';
    } catch (e) {
        logger.warn('Failed to load base instructions by URLs:', e);
        return null;
    }
}
