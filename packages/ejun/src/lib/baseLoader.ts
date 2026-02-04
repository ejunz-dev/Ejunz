import { ObjectId } from 'mongodb';
import { Logger } from '../logger';
import { BaseModel, CardModel } from '../model/base';
import type { BaseNode, BaseEdge } from '../interface';

const logger = new Logger('baseLoader');

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

/** Load node and children content by level; maxLevel -1 = all. Base uses raw card content (no SKILL frontmatter). */
async function loadBaseNodeRecursive(
    domainId: string,
    baseDocId: ObjectId,
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

            if (level === 0) {
                continue;
            } else if (level === 1) {
                content += `\n\n# ${title}\n\n`;
                if (body && (maxLevel < 0 || maxLevel >= 2)) {
                    content += `${body}\n\n`;
                }
            } else {
                const headingLevel = level === 2 ? '##' : level === 3 ? '###' : '####';
                content += `\n${indent}${headingLevel} ${title}\n\n`;

                if (maxLevel >= 0 && level === maxLevel) {
                    if (body) content += `${indent}${body}\n\n`;
                    const children = childrenMap.get(nodeId) || [];
                    if (children.length > 0) {
                        content += `${indent}**子节点:**\n`;
                        for (const child of children) {
                            const childCards = await CardModel.getByNodeId(domainId, baseDocId, child.id);
                            const childName = childCards.length > 0 ? (childCards[0].title || child.text) : child.text;
                            content += `${indent}- ${childName}\n`;
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
        if (level === 1) {
            content += `\n\n# ${node.text}\n\n`;
        } else {
            const headingLevel = Math.min(level + 1, 6);
            const headingMark = '#'.repeat(headingLevel);
            content += `\n${indent}${headingMark} ${node.text}\n\n`;

            if (maxLevel >= 0 && level === maxLevel) {
                const children = childrenMap.get(nodeId) || [];
                if (children.length > 0) {
                    content += `${indent}**子节点:**\n`;
                    for (const child of children) {
                        content += `${indent}- ${child.text}\n`;
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
            rootNode.id,
            nodes,
            childrenMap,
            0,
            maxLevel
        );

        return fullContent ? `\n\n${fullContent}\n\n---\n\n` : null;
    } catch (e) {
        logger.warn('Failed to load base instructions:', e);
        return null;
    }
}
