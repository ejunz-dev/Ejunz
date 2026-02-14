import { ObjectId } from 'mongodb';
import { Logger } from '../logger';
import { BaseModel, CardModel } from '../model/base';
import type { BaseNode, BaseEdge } from '../interface';

const logger = new Logger('baseLoader');

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
 * Parse a single card/node URL (e.g. http://localhost:8000/d/Bazi/base/branch/main?cardId=xxx).
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
        const branchIdx = rest.indexOf('branch');
        const nodeIdx = rest.indexOf('node');

        if (branchIdx !== -1 && rest[branchIdx + 1]) {
            result.branch = rest[branchIdx + 1];
        }
        if (nodeIdx !== -1 && rest[nodeIdx + 1]) {
            result.nodeId = result.nodeId ?? rest[nodeIdx + 1];
        }
        if (branchIdx > 0) {
            result.docId = rest[0];
        }

        return result;
    } catch (e) {
        result.parseError = e instanceof Error ? e.message : 'invalid url';
        return result;
    }
}

/** Build node tree for multi-level base structure (same logic as skillLoader). */
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

/** Build relative URL for a card (knowledge base outline). */
function cardUrl(domainId: string, _baseDocId: ObjectId, branch: string, _nodeId: string, cardId: ObjectId): string {
    return `/d/${domainId}/base/branch/${branch}?cardId=${cardId}`;
}

/** Build relative URL for a node (knowledge base outline). */
function nodeUrl(domainId: string, _baseDocId: ObjectId, branch: string, nodeId: string): string {
    return `/d/${domainId}/base/branch/${branch}?nodeId=${nodeId}`;
}

/** Build relative URL for card lesson (e.g. /d/Bazi/learn/lesson?cardId=xxx). */
function lessonCardUrl(domainId: string, cardId: ObjectId): string {
    return `/d/${domainId}/learn/lesson?cardId=${cardId}`;
}

/** Build relative URL for node lesson (e.g. /d/Bazi/learn/lesson?nodeId=xxx). */
function lessonNodeUrl(domainId: string, nodeId: string): string {
    return `/d/${domainId}/learn/lesson?nodeId=${nodeId}`;
}

/** Load node tree by level: nodes only (no cards). Agent sees full node structure, then opens one node via urls to see its cards. */
async function loadBaseNodeRecursive(
    domainId: string,
    baseDocId: ObjectId,
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
    const nodeLink = nodeUrl(domainId, baseDocId, branch, nodeId);
    const nodeLessonLink = lessonNodeUrl(domainId, nodeId);
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
                    const childLink = nodeUrl(domainId, baseDocId, branch, child.id);
                    const childLessonLink = lessonNodeUrl(domainId, child.id);
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

/**
 * Load base instructions progressively by level.
 * Uses the domain's single base (non-skill). branch defaults to base.currentBranch or 'main'.
 * maxLevel: 1=overview, 2+=depth, -1=full.
 */
export async function loadBaseInstructions(
    domainId: string,
    maxLevel: number = -1,
    branch?: string
): Promise<string | null> {
    try {
        const base = await BaseModel.getByDomain(domainId);
        if (!base) return null;

        const baseDocId = (base as any).docId || (base as any)._id;
        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData = (base as any).branchData || {};
        const data = branchData[branchName] || (branchName === 'main' ? { nodes: (base as any).nodes || [], edges: (base as any).edges || [] } : { nodes: [], edges: [] });
        const nodes: BaseNode[] = data.nodes || [];
        const edges: BaseEdge[] = data.edges || [];

        if (nodes.length === 0) return null;

        const childrenMap = buildNodeTree(nodes, edges);
        const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) && !edges.some(e => e.target === n.id));
        if (rootNodes.length === 0) return null;

        const rootNode = rootNodes[0];
        const fullContent = await loadBaseNodeRecursive(
            domainId,
            baseDocId,
            branchName,
            rootNode.id,
            nodes,
            childrenMap,
            0,
            maxLevel
        );

        return fullContent
            ? `Below is the full node structure only (no cards listed). Each line is a node with base link and Lesson link. Use this to let the agent know all nodes; to see cards under a node, call this tool again with urls containing that node's URL (one node per call).\n\n${fullContent}\n\n---\n\n`
            : null;
    } catch (e) {
        logger.warn('Failed to load base instructions:', e);
        return null;
    }
}

/** Max length for instructions string to avoid agent overflow; truncate with note if over. */
const INSTRUCTIONS_MAX_LENGTH = 12000;

/**
 * Load base instructions for multiple card/node URLs.
 * - cardId URL: returns that card's full content (one card only).
 * - nodeId URL: returns only node name + card titles with links (no card body), to avoid huge output.
 * Total length is capped at INSTRUCTIONS_MAX_LENGTH; excess is truncated.
 */
export async function loadBaseInstructionsByUrls(
    domainId: string,
    urls: string[],
    branch?: string
): Promise<string | null> {
    if (!urls || urls.length === 0) return null;
    try {
        const base = await BaseModel.getByDomain(domainId);
        if (!base) return null;

        const baseDocId = (base as any).docId || (base as any)._id;
        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData = (base as any).branchData || {};
        const data = branchData[branchName] || (branchName === 'main' ? { nodes: (base as any).nodes || [], edges: (base as any).edges || [] } : { nodes: [], edges: [] });
        const nodes: BaseNode[] = data.nodes || [];
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

            if (parsed.cardId) {
                try {
                    const id = new ObjectId(parsed.cardId);
                    if (seenCardIds.has(id.toString())) continue;
                    const card = await CardModel.get(domainId, id);
                    if (card) {
                        seenCardIds.add(id.toString());
                        const title = card.title || 'Untitled';
                        const body = (card.content || '').trim();
                        const nodeId = (card as any).nodeId;
                        const link = nodeId ? cardUrl(domainId, baseDocId, branchName, nodeId, card.docId) : '';
                        const lessonLink = lessonCardUrl(domainId, card.docId);
                        parts.push(
                            link
                                ? `\n\n## [${title}](${link}) [Lesson](${lessonLink})\n\n${body}\n\n`
                                : `\n\n## [${title}](${lessonLink})\n\n${body}\n\n`
                        );
                    }
                } catch (e) {
                    logger.debug('Failed to load card %s: %s', parsed.cardId, (e as Error).message);
                }
                continue;
            }

            if (parsed.nodeId) {
                const node = nodes.find((n) => n.id === parsed.nodeId);
                const nodeTitle = node?.text || 'Node';
                const nodeLink = nodeUrl(domainId, baseDocId, branchName, parsed.nodeId);
                const nodeLessonLink = lessonNodeUrl(domainId, parsed.nodeId);
                const nodeCards = await CardModel.getByNodeId(domainId, baseDocId, parsed.nodeId);
                const cardLines = nodeCards.map((card) => {
                    const title = card.title || 'Untitled';
                    const lessonLink = lessonCardUrl(domainId, card.docId);
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
        let out = `Below is the outline or single-card content for the given link. When giving course URLs, use only the URLs returned here. Never construct a card URL yourself: cardId must be the 24-char hex ID from the link, never the card title (e.g. never ?cardId=壬申). When replying, show links as Markdown hyperlinks.\n\n${multiUrlNote}` + parts.join('');
        if (out.length > INSTRUCTIONS_MAX_LENGTH) {
            out = out.slice(0, INSTRUCTIONS_MAX_LENGTH) + `\n\n---\n(Content truncated, over ${INSTRUCTIONS_MAX_LENGTH} chars. Narrow urls or query by cardId alone.)`;
        }
        return out + '\n\n---\n\n';
    } catch (e) {
        logger.warn('Failed to load base instructions by URLs:', e);
        return null;
    }
}
