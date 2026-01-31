import yaml from 'js-yaml';
import { ObjectId } from 'mongodb';
import { Logger } from '../logger';
import { BaseModel, CardModel } from '../model/base';
import * as document from '../model/document';
import type { CardDoc, BaseNode, BaseEdge } from '../interface';

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

/** 返回指定分支下所有技能的元数据列表（供 loadSkillsMetadata / getSkillNamesForBranch 复用）。branch 为空则返回 []。 */
async function getSkillsMetadataList(domainId: string, branch: string): Promise<{ name: string; description: string; nodeId: string; cardId: string }[]> {
    if (!branch || String(branch).trim() === '') return [];
    const skillsBaseList = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' })
        .limit(1)
        .toArray();
    if (skillsBaseList.length === 0) return [];
    const skillsBase = skillsBaseList[0] as any;
    const branchName = branch || 'main';
    const branchData = skillsBase.branchData?.[branchName] || (branchName === 'main' ? { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] } : { nodes: [], edges: [] });
    const nodes: BaseNode[] = branchData.nodes || [];
    const edges: BaseEdge[] = branchData.edges || [];
    if (nodes.length === 0) return [];
    const childrenMap = buildNodeTree(nodes, edges);
    const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) && !edges.some(e => e.target === n.id));
    if (rootNodes.length === 0) return [];
    const rootNode = rootNodes[0];
    const baseDocId = (skillsBase as any).docId || (skillsBase as any)._id;
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
                // 根节点下每张卡一个技能：优先用卡片标题，避免都用 rootNode.text（如 "Skills"）导致重名、load 时匹配错卡或 instructions 为空
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
        if (skillMetadata.length === 0) {
            return '';
        }
        const skillsList = skillMetadata.map(skill => {
            const desc = skill.description ? `: ${skill.description}` : '';
            return `- **${skill.name}**${desc}`;
        }).join('\n');
        const exampleSkillName = skillMetadata[0]?.name || 'skill_name';
        return `\n\n# Available Agent Skills\n\nThe following Agent Skills are available. Each skill has a hierarchical structure with modules and sub-modules. When you need to use a specific skill, you can request its detailed instructions. The skills will be loaded on-demand to save tokens.\n\n${skillsList}\n\n**Note**: To use a skill, simply mention its name or ask for help with a task that matches the skill's description. The full skill instructions (including all modules and sub-modules) will be provided when needed.\n\n**When the user only asks what tools/skills you have** (e.g. \"你有什么工具\", \"what tools do you have\"), **answer directly** from the tools list and the skill names in this message. Do NOT call \`load_skill_instructions\` or any other tool to answer that question; the list is already in the system message.\n\n**Tool calls in skills**: When skill instructions contain a JSON block with \`tool\` and \`arguments\` (e.g. {\"tool\": \"get_current_time\", \"arguments\": {\"timezone\": \"UTC\"}}), you MUST call that tool with the given arguments and use the result in your response. Do not refuse to call tools that are in your available tools list. **When arguments are already set** (e.g. \`"url": "https://example.com"\` in the loaded instructions), use them directly and call the tool immediately; do NOT ask the user again for the URL or other parameters. **When arguments have empty placeholders** (e.g. \`"url": ""\`, \`"maxLength": ""\`), you MUST fill them from the user's message or conversation context before calling the tool; do not call the tool with empty url or other required fields.\n\n**Built-in Tool Available**: You can use the \`load_skill_instructions\` tool to load instructions for any skill. **Call it only once per skill**: use \`skillName\` (the name from the list above) and omit \`level\` or use \`level=2\` to get full content (including tool name and arguments) in one response. Do NOT call it multiple times (e.g. first level=1 then level=2); one call is enough. Example: \`load_skill_instructions(skillName="${exampleSkillName}")\`\n\n**CRITICAL - Match user request**: When the user asks for a specific task (e.g. \"抓取网页\" / scrape webpage, \"查时间\" / get time), you MUST load the skill that matches that task (e.g. load \"查询网页\" for 抓取网页, \"查询时间\" for 查时间). Only call the tool from the loaded skill content if that tool fulfills the user's request. If the loaded content specifies a different tool (e.g. get_current_time when the user asked to scrape a webpage), do NOT call that tool; load the correct skill for the user's request instead.\n\n**CRITICAL - One load per skill**: Call \`load_skill_instructions\` only **once** for the skill that matches the user's request. One call returns the full content (including tool and arguments). Do NOT call it again for the same skill to get "more detail" or "specific content". After you receive the result, call the tool from that content directly; do NOT call \`load_skill_instructions\` again.\n\n**CRITICAL - Concise response & tool error**: Keep replies short (1–2 sentences when possible). When a tool call returns an error (e.g. \`Tool not found\`, \`error: true\`), you MUST respond in the next message in one short sentence: state what failed and one suggested action (e.g. \"该工具当前不可用，请检查当前 Skill 分支下是否已包含该工具。\"). Do not output long self-reflective or apologetic paragraphs.\n\n---\n\n`;
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

/** Load skill instructions by name; maxLevel 1=overview, 2+=depth, -1=full. Returns null if branch is empty. */
export async function loadSkillInstructions(domainId: string, skillName: string, maxLevel: number = -1, branch?: string): Promise<string | null> {
    if (!branch || String(branch).trim() === '') return null;
    try {
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' })
            .limit(1)
            .toArray();
        
        if (skillsBaseList.length === 0) {
            return null;
        }
        
        const skillsBase = skillsBaseList[0] as any;
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
            // 根节点为 layer，每张 card 为技能：按 card 的 name/title 匹配，或按卡片内容中的工具名匹配（如 fetch_webpage）
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
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' })
            .limit(1)
            .toArray();
        
        if (skillsBaseList.length === 0) {
            return '';
        }
        
        const skillsBase = skillsBaseList[0] as any;
        
        const branchData = skillsBase.branchData?.['main'] || { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] };
        const nodes: BaseNode[] = branchData.nodes || [];
        
        if (nodes.length === 0) {
            return '';
        }
        
        const allCards: CardDoc[] = [];
        for (const node of nodes) {
            const nodeCards = await CardModel.getByNodeId(domainId, skillsBase.docId, node.id);
            allCards.push(...nodeCards);
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
 * branch 为空则返回空集合（不使用 Skill）。
 */
export async function getToolNamesFromSkills(domainId: string, skillNames: string[], branch?: string): Promise<Set<string>> {
    const names = new Set<string>();
    if (!branch || !skillNames?.length) return names;
    for (const skillName of skillNames) {
        try {
            const content = await loadSkillInstructions(domainId, skillName.trim(), -1, branch);
            if (!content) continue;
            for (const toolName of extractToolNamesFromContent(content)) {
                names.add(toolName);
            }
        } catch (e) {
            logger.debug('getToolNamesFromSkills: failed to load skill %s: %s', skillName, (e as Error).message);
        }
    }
    return names;
}

/**
 * Returns tool name -> recommended arguments from assigned skills (first occurrence per tool). Returns empty map if branch is empty.
 */
export async function getToolExamplesFromSkills(domainId: string, skillNames: string[], branch?: string): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    if (!branch || !skillNames?.length) return map;
    for (const skillName of skillNames) {
        try {
            const content = await loadSkillInstructions(domainId, skillName.trim(), -1, branch);
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

