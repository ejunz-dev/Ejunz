import yaml from 'js-yaml';
import { ObjectId } from 'mongodb';
import { _, Filter } from '../libs';
import { Logger } from '../logger';
import * as document from './document';
import type { BaseEdge, BaseNode, SkillDoc, CardDoc, BaseDoc } from '../interface';
import { BaseModel, CardModel } from './base';

export class SkillModel {
    static async generateNextDocId(domainId: string): Promise<number> {
        const last = await document.getMulti(domainId, document.TYPE_SKILL, { docId: { $type: 'number' } } as any)
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (Number(last[0]?.docId) || 0) + 1;
    }

    static async get(domainId: string, docId: number): Promise<SkillDoc | null> {
        return (await BaseModel.get(domainId, docId, document.TYPE_SKILL)) as SkillDoc | null;
    }

    static async getBybid(domainId: string, bid: string | number): Promise<SkillDoc | null> {
        const bidString = String(bid).trim();
        if (!bidString) return null;
        const list = await document.getMulti(domainId, document.TYPE_SKILL, { bid: bidString } as Filter<SkillDoc>).limit(1).toArray();
        return list.length > 0 ? (list[0] as SkillDoc) : null;
    }

    static async getAll(domainId: string): Promise<SkillDoc[]> {
        return await document.getMulti(domainId, document.TYPE_SKILL, {}).sort({ updateAt: -1 }).toArray() as SkillDoc[];
    }

    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<SkillDoc[]> {
        return await document
            .getMulti(domainId, document.TYPE_SKILL, {})
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray() as SkillDoc[];
    }

    static async create(
        domainId: string,
        owner: number,
        title: string,
        content: string = '',
        branch: string = 'main',
        ip?: string,
        domainName?: string,
        bid?: string,
        /** If set, root mind-map node label (document `title` is unchanged). */
        rootNodeText?: string,
    ): Promise<{ docId: number }> {
        const rootLabel = (rootNodeText != null && String(rootNodeText).trim() !== '')
            ? String(rootNodeText).trim()
            : (title || domainName || 'Skills');
        const rootNode: BaseNode = {
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            text: rootLabel,
            x: 0,
            y: 0,
            level: 0,
            expanded: true,
        };

        const payload: Partial<SkillDoc> = {
            docType: document.TYPE_SKILL,
            domainId,
            title: title || '未命名技能库',
            content: content || '',
            owner,
            bid: bid ? String(bid).trim() : undefined,
            nodes: [rootNode],
            edges: [],
            layout: {
                type: 'hierarchical',
                direction: 'LR',
                spacing: { x: 200, y: 100 },
            },
            viewport: {
                x: 0,
                y: 0,
                zoom: 1,
            },
            createdAt: new Date(),
            updateAt: new Date(),
            views: 0,
            ip,
            branch,
        };

        const nextDocId = await this.generateNextDocId(domainId);
        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_SKILL,
            nextDocId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        return { docId: Number(docId) };
    }

    static async delete(domainId: string, docId: number): Promise<void> {
        await BaseModel.delete(domainId, docId, document.TYPE_SKILL);
    }

    static async update(
        domainId: string,
        docId: number,
        updates: Parameters<typeof BaseModel.update>[2],
    ): Promise<void> {
        await BaseModel.update(domainId, docId, updates, document.TYPE_SKILL);
    }

    static async addNode(
        domainId: string,
        docId: number,
        node: Omit<BaseNode, 'id'>,
        parentId?: string,
        branch?: string,
        edgeSourceId?: string,
    ) {
        return BaseModel.addNode(domainId, docId, node, parentId, branch, edgeSourceId, document.TYPE_SKILL);
    }

    static async updateNode(
        domainId: string,
        docId: number,
        nodeId: string,
        updates: Partial<BaseNode>,
        branch?: string,
    ): Promise<void> {
        await BaseModel.updateNode(domainId, docId, nodeId, updates, branch, document.TYPE_SKILL);
    }

    static async deleteNode(domainId: string, docId: number, nodeId: string, branch?: string): Promise<void> {
        await BaseModel.deleteNode(domainId, docId, nodeId, branch, document.TYPE_SKILL);
    }

    static async addEdge(
        domainId: string,
        docId: number,
        edge: Omit<BaseEdge, 'id'>,
        branch?: string,
    ): Promise<string> {
        return BaseModel.addEdge(domainId, docId, edge, branch, document.TYPE_SKILL);
    }

    static async deleteEdge(domainId: string, docId: number, edgeId: string, branch?: string): Promise<void> {
        await BaseModel.deleteEdge(domainId, docId, edgeId, branch, document.TYPE_SKILL);
    }

    static async updateFull(
        domainId: string,
        docId: number,
        updates: Parameters<typeof BaseModel.updateFull>[2],
    ): Promise<void> {
        await BaseModel.updateFull(domainId, docId, updates, document.TYPE_SKILL);
    }

    static async incrementViews(domainId: string, docId: number): Promise<void> {
        await BaseModel.incrementViews(domainId, docId, document.TYPE_SKILL);
    }
}

export type SkillLibraryBinding = { docId: number; branch: string };
export type SkillSourceResolution = { branch: string; docId: number };

/** Branch names available on a skill mind-map document (`main` + `branchData` keys + `currentBranch`). */
export function listBranchNamesForSkillDoc(base: SkillDoc | BaseDoc | Record<string, unknown>): string[] {
    const s = new Set<string>(['main']);
    const raw = (base as any).branchData;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const k of Object.keys(raw)) {
            const b = String(k || '').trim();
            if (b) s.add(b);
        }
    }
    const cb = (base as any).currentBranch;
    if (typeof cb === 'string' && cb.trim()) s.add(cb.trim());
    return [...s];
}

export async function resolveSkillDocByIdOrBid(domainId: string, docIdOrBid: string): Promise<SkillDoc | null> {
    const key = String(docIdOrBid || '').trim();
    if (!key) return null;
    if (/^\d+$/.test(key)) {
        const byDocId = await SkillModel.get(domainId, Number(key));
        if (byDocId) return byDocId;
    }
    return SkillModel.getBybid(domainId, key);
}

const logger = new Logger('skillLoader');

export interface SkillMetadata {
    name: string;
    description: string;
}

export interface SkillContent {
    metadata: SkillMetadata;
    instructions: string; // SKILL.md body (no YAML frontmatter)
}

/** Parse SKILL.md: extract YAML frontmatter and body. */
export function parseSkillMd(content: string): { metadata: SkillMetadata; instructions: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);
    
    if (!match) {
        return {
            metadata: { name: 'Unnamed Skill', description: '' },
            instructions: content,
        };
    }
    
    const [, frontmatter, instructions] = match;
    
    try {
        const metadata = yaml.load(frontmatter) as SkillMetadata;
        if (!metadata.name) {
            metadata.name = 'Unnamed Skill';
        }
        if (!metadata.description) {
            metadata.description = '';
        }
        return { metadata, instructions: instructions.trim() };
    } catch (e) {
        logger.error('Failed to parse skill frontmatter:', e);
        return {
            metadata: { name: 'Unnamed Skill', description: '' },
            instructions: content,
        };
    }
}

/** Build node tree for multi-level skill structure. */
function buildNodeTree(nodes: BaseNode[], edges: BaseEdge[]): Map<string, BaseNode[]> {
    const childrenMap = new Map<string, BaseNode[]>();
    const nodeMap = new Map<string, BaseNode>();
    
    nodes.forEach(node => nodeMap.set(node.id, node));
    
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

/** Collect skill metadata rows from one skill-type base document and branch. */
async function collectSkillMetadataFromOneBase(
    domainId: string,
    skillsBase: any,
    branch: string,
): Promise<{ name: string; description: string; nodeId: string; cardId: string }[]> {
    const branchName = branch || 'main';
    const branchData = skillsBase.branchData?.[branchName] || (branchName === 'main' ? { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] } : { nodes: [], edges: [] });
    const nodes: BaseNode[] = branchData.nodes || [];
    const edges: BaseEdge[] = branchData.edges || [];
    if (nodes.length === 0) return [];
    const childrenMap = buildNodeTree(nodes, edges);
    const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) && !edges.some(e => e.target === n.id));
    if (rootNodes.length === 0) return [];
    const rootNode = rootNodes[0];
    const baseDocId = skillsBase.docId || skillsBase._id;
    const skillNodes = childrenMap.get(rootNode.id) || nodes.filter(n => n.parentId === rootNode.id || edges.some(e => e.source === rootNode.id && e.target === n.id));
    const skillMetadata: { name: string; description: string; nodeId: string; cardId: string }[] = [];
    if (skillNodes.length > 0) {
        for (const skillNode of skillNodes) {
            const nodeCards = await CardModel.getByNodeId(domainId, baseDocId, skillNode.id);
            if (nodeCards.length > 0) {
                const card = nodeCards[0];
                const cardId = (card.docId || (card as any)._id)?.toString() || '';
                try {
                    const { metadata } = parseSkillMd(card.content || '');
                    const overview = card.content ? card.content.replace(/^---[\s\S]*?---\s*\n/, '').trim().substring(0, 200) : '';
                    const displayName = (metadata.name && metadata.name !== 'Unnamed Skill') ? metadata.name : (skillNode.text || card.title);
                    skillMetadata.push({ name: displayName, description: metadata.description || overview || '', nodeId: skillNode.id, cardId });
                } catch (e) {
                    logger.warn(`Failed to parse skill metadata for node ${skillNode.id}:`, e);
                    skillMetadata.push({ name: skillNode.text || card.title, description: '', nodeId: skillNode.id, cardId });
                }
            } else {
                skillMetadata.push({ name: skillNode.text, description: '', nodeId: skillNode.id, cardId: '' });
            }
        }
    } else {
        const rootCards = await CardModel.getByNodeId(domainId, baseDocId, rootNode.id);
        for (const card of rootCards) {
            const cardId = (card.docId || (card as any)._id)?.toString() || '';
            try {
                const { metadata } = parseSkillMd(card.content || '');
                const overview = card.content ? card.content.replace(/^---[\s\S]*?---\s*\n/, '').trim().substring(0, 200) : '';
                const displayName = (metadata.name && metadata.name !== 'Unnamed Skill') ? metadata.name : (card.title || rootNode.text);
                skillMetadata.push({ name: displayName, description: metadata.description || overview || '', nodeId: rootNode.id, cardId });
            } catch (e) {
                logger.warn(`Failed to parse skill metadata for root card ${card.title}:`, e);
                skillMetadata.push({ name: card.title || rootNode.text, description: '', nodeId: rootNode.id, cardId });
            }
        }
    }
    return skillMetadata;
}

/** 返回指定分支下所有技能的元数据列表（供 loadSkillsMetadata / getSkillNamesForBranch 复用）。branch 为空则返回 []。 */
async function getSkillsMetadataList(domainId: string, branch: string): Promise<{ name: string; description: string; nodeId: string; cardId: string }[]> {
    if (!branch || String(branch).trim() === '') return [];
    const skillsBaseList = await document.getMulti(domainId, document.TYPE_SKILL, {})
        .sort({ updateAt: -1 })
        .toArray();
    const aggregated: { name: string; description: string; nodeId: string; cardId: string }[] = [];
    for (const skillsBase of skillsBaseList) {
        const part = await collectSkillMetadataFromOneBase(domainId, skillsBase as any, branch);
        aggregated.push(...part);
    }
    return aggregated;
}

/** Returns ordered unique skill names + map name → library source (branch + docId). */
export async function getSkillNamesAndResolutionMap(
    domainId: string,
    bindings: SkillLibraryBinding[],
): Promise<{ names: string[]; map: Map<string, SkillSourceResolution> }> {
    const map = new Map<string, SkillSourceResolution>();
    const names: string[] = [];
    for (const { docId, branch } of bindings) {
        if (!Number.isFinite(docId) || docId <= 0) continue;
        const b = await SkillModel.get(domainId, docId);
        if (!b) continue;
        const br = String(branch || 'main').trim() || 'main';
        const part = await collectSkillMetadataFromOneBase(domainId, b as any, br);
        for (const r of part) {
            const nm = String(r.name || '').trim();
            if (!nm) continue;
            if (!map.has(nm)) names.push(nm);
            map.set(nm, { branch: br, docId });
        }
    }
    return { names, map };
}

async function getSkillsMetadataRowsForBindings(
    domainId: string,
    bindings: SkillLibraryBinding[],
): Promise<{ name: string; description: string }[]> {
    const out: { name: string; description: string }[] = [];
    const seen = new Set<string>();
    for (const { docId, branch } of bindings) {
        if (!Number.isFinite(docId) || docId <= 0) continue;
        const b = await SkillModel.get(domainId, docId);
        if (!b) continue;
        const br = String(branch || 'main').trim() || 'main';
        const part = await collectSkillMetadataFromOneBase(domainId, b as any, br);
        for (const r of part) {
            const key = String(r.name || '').trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push({ name: r.name, description: r.description || '' });
        }
    }
    return out;
}

function buildSkillsMetadataSystemBlock(skillMetadata: { name: string; description: string }[]): string {
    if (skillMetadata.length === 0) return '';
    const skillsList = skillMetadata.map((skill) => {
        const desc = skill.description ? `: ${skill.description}` : '';
        return `- **${skill.name}**${desc}`;
    }).join('\n');
    const exampleSkillName = skillMetadata[0]?.name || 'skill_name';
    return `\n\n# Available Agent Skills\n\nThe following Agent Skills are available. Each skill has a hierarchical structure with modules and sub-modules. When you need to use a specific skill, you can request its detailed instructions. The skills will be loaded on-demand to save tokens.\n\n${skillsList}\n\n**Note**: To use a skill, simply mention its name or ask for help with a task that matches the skill's description. The full skill instructions (including all modules and sub-modules) will be provided when needed.\n\n**When the user only asks what tools/skills you have** (e.g. \"你有什么工具\", \"what tools do you have\"), **answer directly** from the tools list and the skill names in this message. Do NOT call \`load_skill_instructions\` or any other tool to answer that question; the list is already in the system message.\n\n**Tool calls in skills**: When skill instructions contain a JSON block with \`tool\` and \`arguments\` (e.g. {\"tool\": \"get_current_time\", \"arguments\": {\"timezone\": \"UTC\"}}), you MUST call that tool with the given arguments and use the result in your response. Do not refuse to call tools that are in your available tools list. **When arguments are already set** (e.g. \`"url": "https://example.com"\` in the loaded instructions), use them directly and call the tool immediately; do NOT ask the user again for the URL or other parameters. **When arguments have empty placeholders** (e.g. \`"url": ""\`, \`"maxLength": ""\`), you MUST fill them from the user's message or conversation context before calling the tool; do not call the tool with empty url or other required fields.\n\n**Built-in Tool Available**: You can use the \`load_skill_instructions\` tool to load instructions for any skill. **Call it only once per skill**: use \`skillName\` (the name from the list above) and omit \`level\` or use \`level=2\` to get full content (including tool name and arguments) in one response. Do NOT call it multiple times (e.g. first level=1 then level=2); one call is enough. Example: \`load_skill_instructions(skillName="${exampleSkillName}")\`\n\n**CRITICAL - Match user request**: When the user asks for a specific task (e.g. \"抓取网页\" / scrape webpage, \"查时间\" / get time), you MUST load the skill that matches that task (e.g. load \"查询网页\" for 抓取网页, \"查询时间\" for 查时间). Only call the tool from the loaded skill content if that tool fulfills the user's request. If the loaded content specifies a different tool (e.g. get_current_time when the user asked to scrape a webpage), do NOT call that tool; load the correct skill for the user's request instead.\n\n**CRITICAL - One load per skill**: Call \`load_skill_instructions\` only **once** for the skill that matches the user's request. One call returns the full content (including tool and arguments). Do NOT call it again for the same skill to get "more detail" or "specific content". After you receive the result, call the tool from that content directly; do NOT call \`load_skill_instructions\` again.\n\n**CRITICAL - Concise response & tool error codes**: Keep replies short (1–2 sentences). When a tool call returns an error, check the \`code\` field and reply as follows:\n- **TOOL_NOT_ADDED**: The tool exists in the catalog but was not added to this domain. Tell the user: \"该工具尚未添加，请到本域【工具市场】添加该工具后再试。\" or similar.\n- **TOOL_NOT_FOUND**: The tool does not exist in the market. Tell the user the tool is unavailable or the name is invalid.\n- **TIMEOUT** / **NETWORK_ERROR** / **SERVER_ERROR**: Suggest retry or check network/server.\n- Other codes: State what failed in one short sentence and one suggested action. Do not output long self-reflective or apologetic paragraphs.\n\n---\n\n`;
}

/** Load skills system prompt from selected libraries + branches (exclusive; use with skillLibraryBindings). */
export async function loadSkillsMetadataForBindings(domainId: string, bindings: SkillLibraryBinding[]): Promise<string> {
    if (!bindings.length) return '';
    try {
        const rows = await getSkillsMetadataRowsForBindings(domainId, bindings);
        return buildSkillsMetadataSystemBlock(rows);
    } catch (e) {
        logger.warn('Failed to load Skills metadata (bindings):', e);
        return '';
    }
}

/** Returns all skill names for the branch (used when skillIds is empty to resolve tools by branch). */
export async function getSkillNamesForBranch(domainId: string, branch: string): Promise<string[]> {
    if (!branch || String(branch).trim() === '') return [];
    try {
        const list = await getSkillsMetadataList(domainId, branch);
        return list.map(s => s.name);
    } catch (e) {
        logger.warn('getSkillNamesForBranch failed:', e);
        return [];
    }
}

/** Load domain skills metadata (name + description only). Returns empty if branch is empty. */
export async function loadSkillsMetadata(domainId: string, branch?: string): Promise<string> {
    if (!branch || String(branch).trim() === '') return '';
    try {
        const skillMetadata = await getSkillsMetadataList(domainId, branch);
        const rows = skillMetadata.map((s) => ({ name: s.name, description: s.description || '' }));
        return buildSkillsMetadataSystemBlock(rows);
    } catch (e) {
        logger.warn('Failed to load Skills metadata:', e);
        return '';
    }
}

/** Load node and children content by level; maxLevel -1 = all. */
async function loadNodeContentRecursive(
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
            const { metadata, instructions } = parseSkillMd(card.content || '');
            const cardTitle = metadata.name || card.title || node.text;
            
            if (level === 0) {
                continue;
            } else if (level === 1) {
                content += `\n\n# ${cardTitle}\n\n`;
                if (metadata.description) {
                    content += `${metadata.description}\n\n`;
                }
                if (instructions && (maxLevel < 0 || maxLevel >= 2)) {
                    content += `${instructions}\n\n`;
                }
            } else {
                const headingLevel = level === 2 ? '##' : level === 3 ? '###' : '####';
                content += `\n${indent}${headingLevel} ${cardTitle}\n\n`;
                
                if (maxLevel >= 0 && level === maxLevel) {
                    if (metadata.description) {
                        content += `${indent}${metadata.description}\n\n`;
                    }
                    const children = childrenMap.get(nodeId) || [];
                    if (children.length > 0) {
                        content += `${indent}**Submodules:**\n`;
                        for (const child of children) {
                            const childCards = await CardModel.getByNodeId(domainId, baseDocId, child.id);
                            const childName = childCards.length > 0 
                                ? (parseSkillMd(childCards[0].content || '').metadata.name || child.text)
                                : child.text;
                            content += `${indent}- ${childName}\n`;
                        }
                        content += '\n';
                    }
                } else {
                    if (metadata.description) {
                        content += `${indent}${metadata.description}\n\n`;
                    }
                    if (instructions) {
                        const indentedInstructions = instructions.split('\n')
                            .map(line => line.trim() ? `${indent}${line}` : '')
                            .join('\n');
                        content += `${indentedInstructions}\n\n`;
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
                    content += `${indent}**Submodules:**\n`;
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
            content += await loadNodeContentRecursive(
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

async function loadSkillInstructionsInBase(
    domainId: string,
    skillsBase: any,
    skillName: string,
    maxLevel: number,
    branch: string,
): Promise<string | null> {
    const branchName = branch || 'main';
    const branchData = skillsBase.branchData?.[branchName] || (branchName === 'main' ? { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] } : { nodes: [], edges: [] });
    const nodes: BaseNode[] = branchData.nodes || [];
    const edges: BaseEdge[] = branchData.edges || [];

    const childrenMap = buildNodeTree(nodes, edges);

    const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) &&
        !edges.some(e => e.target === n.id));

    if (rootNodes.length === 0) {
        return null;
    }

    const rootNode = rootNodes[0];
    const baseDocId = skillsBase.docId || skillsBase._id;

    const skillNodes = childrenMap.get(rootNode.id) ||
        nodes.filter(n => n.parentId === rootNode.id ||
            edges.some(e => e.source === rootNode.id && e.target === n.id));

    if (skillNodes.length > 0) {
        for (const skillNode of skillNodes) {
            const nodeCards = await CardModel.getByNodeId(domainId, baseDocId, skillNode.id);
            let skillNodeName = skillNode.text;

            if (nodeCards.length > 0) {
                const { metadata } = parseSkillMd(nodeCards[0].content || '');
                skillNodeName = metadata.name || skillNode.text || nodeCards[0].title;
            }

            if (skillNodeName.toLowerCase().includes(skillName.toLowerCase()) ||
                skillName.toLowerCase().includes(skillNodeName.toLowerCase())) {
                const fullContent = await loadNodeContentRecursive(
                    domainId,
                    baseDocId,
                    skillNode.id,
                    nodes,
                    childrenMap,
                    1,
                    maxLevel
                );
                return fullContent ? `\n\n${fullContent}\n\n---\n\n` : null;
            }
        }
    } else {
        const rootCards = await CardModel.getByNodeId(domainId, baseDocId, rootNode.id);
        for (const card of rootCards) {
            let cardSkillName = card.title || rootNode.text;
            try {
                const { metadata } = parseSkillMd(card.content || '');
                cardSkillName = (metadata.name && metadata.name !== 'Unnamed Skill') ? metadata.name : (card.title || rootNode.text);
            } catch (_) { /* ignore */ }
            const nameMatches = cardSkillName && (cardSkillName.toLowerCase().includes(skillName.toLowerCase()) ||
                skillName.toLowerCase().includes(cardSkillName.toLowerCase()));
            const contentMatchesTool = (card.content || '').includes(skillName);
            if (nameMatches || contentMatchesTool) {
                const { instructions } = parseSkillMd(card.content || '');
                const body = instructions || (card.content || '').trim();
                return body ? `\n\n${body}\n\n---\n\n` : null;
            }
        }
    }

    return null;
}

/** Load skill instructions by name; maxLevel 1=overview, 2+=depth, -1=full. Returns null if branch is empty. */
export async function loadSkillInstructions(
    domainId: string,
    skillName: string,
    maxLevel: number = -1,
    branch?: string,
    /** When set, only this TYPE_SKILL document is searched (agent library bindings). */
    restrictDocId?: number,
): Promise<string | null> {
    if (!branch || String(branch).trim() === '') return null;
    try {
        if (restrictDocId != null && Number.isFinite(restrictDocId) && restrictDocId > 0) {
            const skillsBase = await SkillModel.get(domainId, restrictDocId);
            if (!skillsBase) return null;
            return await loadSkillInstructionsInBase(domainId, skillsBase as any, skillName, maxLevel, branch);
        }
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_SKILL, {})
            .sort({ updateAt: -1 })
            .toArray();

        for (const skillsBase of skillsBaseList) {
            const hit = await loadSkillInstructionsInBase(domainId, skillsBase as any, skillName, maxLevel, branch);
            if (hit) return hit;
        }

        return null;
    } catch (e) {
        logger.warn(`Failed to load skill instructions for ${skillName}:`, e);
        return null;
    }
}

/** Load skill to level 2 (module list only). */
export async function loadSkillToLevel2(domainId: string, skillName: string): Promise<string | null> {
    return loadSkillInstructions(domainId, skillName, 2);
}

/** Load skill to level 3 (module + submodule list only). */
export async function loadSkillToLevel3(domainId: string, skillName: string): Promise<string | null> {
    return loadSkillInstructions(domainId, skillName, 3);
}

/** Load full skill content (all levels). */
export async function loadSkillFull(domainId: string, skillName: string): Promise<string | null> {
    return loadSkillInstructions(domainId, skillName, -1);
}

/** Load all domain skills from Base cards; returns formatted string for system message. @deprecated Use loadSkillsMetadata() */
export async function loadSkillsInstructions(domainId: string): Promise<string> {
    try {
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_SKILL, {})
            .sort({ updateAt: -1 })
            .toArray();

        if (skillsBaseList.length === 0) {
            return '';
        }

        const allCards: CardDoc[] = [];
        for (const skillsBase of skillsBaseList) {
            const sb = skillsBase as any;
            const branchData = sb.branchData?.['main'] || { nodes: sb.nodes || [], edges: sb.edges || [] };
            const nodes: BaseNode[] = branchData.nodes || [];
            if (nodes.length === 0) continue;
            for (const node of nodes) {
                const nodeCards = await CardModel.getByNodeId(domainId, sb.docId, node.id);
                allCards.push(...nodeCards);
            }
        }

        if (!allCards || allCards.length === 0) {
            return '';
        }
        
        const skillContents = allCards.map((card) => {
            try {
                const { metadata, instructions } = parseSkillMd(card.content || '');
                return {
                    name: metadata.name || card.title,
                    description: metadata.description || '',
                    instructions,
                };
            } catch (e) {
                logger.warn(`Failed to parse skill ${card.title}:`, e);
                return {
                    name: card.title,
                    description: '',
                    instructions: card.content || '',
                };
            }
        });
        
        const validSkills = skillContents.filter(s => s.instructions);
        if (validSkills.length === 0) {
            return '';
        }
        
        const skillsText = validSkills.map(skill => {
            return `## ${skill.name}\n\n${skill.description ? skill.description + '\n\n' : ''}${skill.instructions}`;
        }).join('\n\n---\n\n');
        
        return `\n\n# Agent Skills\n\nThe following Agent Skills are available and should be used when relevant:\n\n${skillsText}\n\n---\n\n`;
    } catch (e) {
        logger.warn('Failed to load Skills:', e);
        return '';
    }
}

const TOOL_NAME_IN_SKILL_REGEX = /"tool"\s*:\s*"([^"]+)"/g;
/** Single-quoted tool name in skill content, e.g. 'tool': 'fetch_webpage' */
const TOOL_NAME_IN_SKILL_REGEX_SINGLE = /'tool'\s*:\s*'([^']+)'/g;

/** Extract all tool names from skill content (double- and single-quoted). */
function extractToolNamesFromContent(content: string): string[] {
    const names: string[] = [];
    TOOL_NAME_IN_SKILL_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOOL_NAME_IN_SKILL_REGEX.exec(content)) !== null) names.push(m[1]);
    TOOL_NAME_IN_SKILL_REGEX_SINGLE.lastIndex = 0;
    while ((m = TOOL_NAME_IN_SKILL_REGEX_SINGLE.exec(content)) !== null) names.push(m[1]);
    return names;
}

/** Extract tool name + arguments from skill content (brace-matched). */
function extractToolExamplesFromText(content: string): Array<{ tool: string; arguments: Record<string, unknown> }> {
    const results: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    TOOL_NAME_IN_SKILL_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOOL_NAME_IN_SKILL_REGEX.exec(content)) !== null) {
        const toolName = m[1];
        const afterTool = content.slice(m.index + m[0].length);
        const argsMatch = afterTool.match(/\s*,\s*"arguments"\s*:\s*(\{)/);
        if (!argsMatch) continue;
        const patternStart = afterTool.indexOf(argsMatch[0]);
        const argsBraceStart = patternStart + argsMatch[0].length - 1; // index of "{"
        const argsStart = m.index + m[0].length + argsBraceStart;
        let depth = 1;
        let pos = argsStart + 1;
        while (pos < content.length && depth > 0) {
            const ch = content[pos];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            pos++;
        }
        if (depth !== 0) continue;
        const argsStr = content.slice(argsStart, pos);
        try {
            const args = JSON.parse(argsStr) as Record<string, unknown>;
            results.push({ tool: toolName, arguments: args });
        } catch {
            // ignore invalid JSON
        }
    }
    return results;
}

/**
 * Returns the set of tool names referenced in the given skills (by name).
 * Optional `sourceByName` maps each skill name to branch + library docId (per-binding agents).
 */
export async function getToolNamesFromSkills(
    domainId: string,
    skillNames: string[],
    branch?: string,
    sourceByName?: Map<string, SkillSourceResolution>,
): Promise<Set<string>> {
    const names = new Set<string>();
    const hasSource = sourceByName && sourceByName.size > 0;
    if (!branch && !hasSource) return names;
    for (const skillName of skillNames || []) {
        try {
            const sn = skillName.trim();
            if (!sn) continue;
            const res = sourceByName?.get(sn);
            const br = res?.branch ?? branch;
            const docId = res?.docId;
            if (!br) continue;
            const content = await loadSkillInstructions(domainId, sn, -1, br, docId);
            if (!content) continue;
            for (const toolName of extractToolNamesFromContent(content)) {
                names.add(toolName);
            }
        } catch (e) {
            logger.debug('getToolNamesFromSkills: failed to load skill %s: %s', skillName, (e as Error).message);
        }
    }
    if (branch || hasSource) {
        try {
            const base = await BaseModel.getByDomain(domainId);
            if (base) names.add('load_base_instructions');
        } catch (e) {
            logger.debug('getToolNamesFromSkills: failed to check base for load_base_instructions: %s', (e as Error).message);
        }
    }
    return names;
}

/**
 * Returns tool name -> recommended arguments from assigned skills (first occurrence per tool).
 */
export async function getToolExamplesFromSkills(
    domainId: string,
    skillNames: string[],
    branch?: string,
    sourceByName?: Map<string, SkillSourceResolution>,
): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    const hasSource = sourceByName && sourceByName.size > 0;
    if ((!branch && !hasSource) || !skillNames?.length) return map;
    for (const skillName of skillNames) {
        try {
            const sn = skillName.trim();
            if (!sn) continue;
            const res = sourceByName?.get(sn);
            const br = res?.branch ?? branch;
            const docId = res?.docId;
            if (!br) continue;
            const content = await loadSkillInstructions(domainId, sn, -1, br, docId);
            if (!content) continue;
            const examples = extractToolExamplesFromText(content);
            for (const { tool, arguments: args } of examples) {
                if (!map.has(tool)) map.set(tool, args);
            }
        } catch (e) {
            logger.debug('getToolExamplesFromSkills: failed to load skill %s: %s', skillName, (e as Error).message);
        }
    }
    return map;
}

