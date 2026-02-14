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

/** Build relative URL for a card. Outline page with ?cardId= (e.g. /d/Bazi/base/branch/main?cardId=xxx). */
function cardUrl(domainId: string, _baseDocId: ObjectId, branch: string, _nodeId: string, cardId: ObjectId): string {
    return `/d/${domainId}/base/branch/${branch}?cardId=${cardId}`;
}

/** Build relative URL for a node. Outline page with ?nodeId= (e.g. /d/Bazi/base/branch/main?nodeId=xxx). */
function nodeUrl(domainId: string, _baseDocId: ObjectId, branch: string, nodeId: string): string {
    return `/d/${domainId}/base/branch/${branch}?nodeId=${nodeId}`;
}

/** Load node and children content by level; maxLevel -1 = all. Base uses raw card content (no SKILL frontmatter). Each card block includes a link URL. */
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

    const nodeCards = await CardModel.getByNodeId(domainId, baseDocId, nodeId);
    if (nodeCards.length > 0) {
        for (const card of nodeCards) {
            const title = card.title || node.text || 'Untitled';
            const body = (card.content || '').trim();
            const link = cardUrl(domainId, baseDocId, branch, nodeId, card.docId);

            if (level === 0) {
                continue;
            } else if (level === 1) {
                content += `\n\n# [${title}](${link})\n\n`;
                if (body && (maxLevel < 0 || maxLevel >= 2)) {
                    content += `${body}\n\n`;
                }
            } else {
                const headingLevel = level === 2 ? '##' : level === 3 ? '###' : '####';
                content += `\n${indent}${headingLevel} [${title}](${link})\n\n`;

                if (maxLevel >= 0 && level === maxLevel) {
                    if (body) content += `${indent}${body}\n\n`;
                    const children = childrenMap.get(nodeId) || [];
                    if (children.length > 0) {
                        content += `${indent}**子节点:**\n`;
                        for (const child of children) {
                            const childCards = await CardModel.getByNodeId(domainId, baseDocId, child.id);
                            const childName = childCards.length > 0 ? (childCards[0].title || child.text) : child.text;
                            const childLink = nodeUrl(domainId, baseDocId, branch, child.id);
                            content += `${indent}- [${childName}](${childLink})\n`;
                        }
                        content += '\n';
                    }
                } else {
                    if (body) {
                        const indentedBody = body.split('\n')
                            .map(line => line.trim() ? `${indent}${line}` : '')
                            .join('\n');
                        content += `${indentedBody}\n\n`;
                    }
                }
            }
        }
    } else if (node.text) {
        const link = nodeUrl(domainId, baseDocId, branch, nodeId);
        if (level === 1) {
            content += `\n\n# [${node.text}](${link})\n\n`;
        } else {
            const headingLevel = Math.min(level + 1, 6);
            const headingMark = '#'.repeat(headingLevel);
            content += `\n${indent}${headingMark} [${node.text}](${link})\n\n`;

            if (maxLevel >= 0 && level === maxLevel) {
                const children = childrenMap.get(nodeId) || [];
                if (children.length > 0) {
                    content += `${indent}**子节点:**\n`;
                    for (const child of children) {
                        const childLink = nodeUrl(domainId, baseDocId, branch, child.id);
                        content += `${indent}- [${child.text}](${childLink})\n`;
                    }
                    content += '\n';
                }
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

        return fullContent ? `以下知识库内容中每项均带有「打开卡片」或「打开节点」链接，回复用户时请原样保留并展示这些链接。\n\n${fullContent}\n\n---\n\n` : null;
    } catch (e) {
        logger.warn('Failed to load base instructions:', e);
        return null;
    }
}

/**
 * Load base instructions for multiple card/node URLs.
 * Only loads URLs whose parsed domainId matches the given domainId.
 * Returns combined content for all resolved cards (by cardId or by nodeId); dedupes by cardId.
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
        const seenCardIds = new Set<string>();
        const parts: string[] = [];

        for (const raw of urls) {
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
                        parts.push(link ? `\n\n## [${title}](${link})\n\n${body}\n\n` : `\n\n## ${title}\n\n${body}\n\n`);
                    }
                } catch (e) {
                    logger.debug('Failed to load card %s: %s', parsed.cardId, (e as Error).message);
                }
                continue;
            }

            if (parsed.nodeId) {
                const nodeCards = await CardModel.getByNodeId(domainId, baseDocId, parsed.nodeId);
                for (const card of nodeCards) {
                    const cid = card.docId.toString();
                    if (seenCardIds.has(cid)) continue;
                    seenCardIds.add(cid);
                    const title = card.title || 'Untitled';
                    const body = (card.content || '').trim();
                    const nodeId = (card as any).nodeId || parsed.nodeId;
                    const link = nodeId ? cardUrl(domainId, baseDocId, branchName, nodeId, card.docId) : '';
                    parts.push(link ? `\n\n## [${title}](${link})\n\n${body}\n\n` : `\n\n## ${title}\n\n${body}\n\n`);
                }
            }
        }

        return parts.length > 0 ? `以下内容中每项均带有「打开卡片」链接，回复用户时请原样保留并展示这些链接。\n\n` + parts.join('') + '\n---\n\n' : null;
    } catch (e) {
        logger.warn('Failed to load base instructions by URLs:', e);
        return null;
    }
}
