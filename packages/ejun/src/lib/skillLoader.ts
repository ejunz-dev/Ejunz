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
    instructions: string; // SKILL.md 的主体内容（去除 YAML frontmatter）
}

/**
 * 解析 SKILL.md 内容，提取 YAML frontmatter 和主体内容
 */
export function parseSkillMd(content: string): { metadata: SkillMetadata; instructions: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);
    
    if (!match) {
        // 没有 frontmatter，整个文件作为 instructions
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

/**
 * 构建节点树结构（用于多层级 skill 结构）
 */
function buildNodeTree(nodes: BaseNode[], edges: BaseEdge[]): Map<string, BaseNode[]> {
    const childrenMap = new Map<string, BaseNode[]>();
    const nodeMap = new Map<string, BaseNode>();
    
    // 建立节点映射
    nodes.forEach(node => nodeMap.set(node.id, node));
    
    // 建立父子关系（通过 edges 和 parentId）
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
    
    // 按 level 和 order 排序
    childrenMap.forEach((children) => {
        children.sort((a, b) => {
            if (a.level !== b.level) return (a.level || 0) - (b.level || 0);
            return (a.order || 0) - (b.order || 0);
        });
    });
    
    return childrenMap;
}

/**
 * 加载 domain 的所有 Skills 元数据（渐进式披露 - 多层级结构）
 * 只加载 Level 1 的 skill 节点（skill 名称和描述），不加载子模块和详细内容
 */
export async function loadSkillsMetadata(domainId: string): Promise<string> {
    try {
        // 获取 Skills Base（type='skill'）
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' })
            .limit(1)
            .toArray();
        
        if (skillsBaseList.length === 0) {
            return '';
        }
        
        const skillsBase = skillsBaseList[0] as any;
        const branchData = skillsBase.branchData?.['main'] || { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] };
        const nodes: BaseNode[] = branchData.nodes || [];
        const edges: BaseEdge[] = branchData.edges || [];
        
        if (nodes.length === 0) {
            return '';
        }
        
        // 构建节点树
        const childrenMap = buildNodeTree(nodes, edges);
        
        // 找到根节点（通常是 "Skills" 或 level=0 的节点）
        const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) && 
            !edges.some(e => e.target === n.id));
        
        if (rootNodes.length === 0) {
            return '';
        }
        
        const rootNode = rootNodes[0];
        
        // 获取 Level 1 的 skill 节点（根节点的直接子节点）
        const skillNodes = childrenMap.get(rootNode.id) || 
            nodes.filter(n => n.parentId === rootNode.id || 
                edges.some(e => e.source === rootNode.id && e.target === n.id));
        
        if (skillNodes.length === 0) {
            return '';
        }
        
        // 只加载 Level 1 skill 节点的 metadata（从该节点的第一个 card 中获取）
        const skillMetadata = [];
        for (const skillNode of skillNodes) {
            const nodeCards = await CardModel.getByNodeId(domainId, skillsBase.docId, skillNode.id);
            if (nodeCards.length > 0) {
                // 使用第一个 card 的 frontmatter 作为 skill 的 metadata
                const card = nodeCards[0];
                // 安全获取 cardId（可能使用 docId 或 _id）
                const cardId = (card.docId || (card as any)._id)?.toString() || '';
                
                try {
                    const { metadata } = parseSkillMd(card.content || '');
                    // 只提取前 200 字符作为概述（如果 instructions 很长）
                    const overview = card.content 
                        ? card.content.replace(/^---[\s\S]*?---\s*\n/, '').trim().substring(0, 200)
                        : '';
                    
                    skillMetadata.push({
                        name: metadata.name || skillNode.text || card.title,
                        description: metadata.description || overview || '',
                        nodeId: skillNode.id,
                        cardId,
                    });
                } catch (e) {
                    logger.warn(`Failed to parse skill metadata for node ${skillNode.id}:`, e);
                    skillMetadata.push({
                        name: skillNode.text || card.title,
                        description: '',
                        nodeId: skillNode.id,
                        cardId,
                    });
                }
            } else {
                // 如果没有 card，使用 node 的 text 作为 skill 名称
                skillMetadata.push({
                    name: skillNode.text,
                    description: '',
                    nodeId: skillNode.id,
                    cardId: '',
                });
            }
        }
        
        if (skillMetadata.length === 0) {
            return '';
        }
        
        // 只返回 skill 列表，不包含完整内容（节省 token）
        const skillsList = skillMetadata.map(skill => {
            const desc = skill.description ? `: ${skill.description}` : '';
            return `- **${skill.name}**${desc}`;
        }).join('\n');
        
        return `\n\n# Available Agent Skills\n\nThe following Agent Skills are available. Each skill has a hierarchical structure with modules and sub-modules. When you need to use a specific skill, you can request its detailed instructions. The skills will be loaded on-demand to save tokens.\n\n${skillsList}\n\n**Note**: To use a skill, simply mention its name or ask for help with a task that matches the skill's description. The full skill instructions (including all modules and sub-modules) will be provided when needed.\n\n**Built-in Tool Available**: You can use the \`load_skill_instructions\` tool to load detailed instructions for any skill. Call it with \`skillName\` (the name of the skill) and optionally \`level\` (1 for overview, 2+ for specific depth, or omit for full content). The system supports unlimited depth levels. Example: \`load_skill_instructions(skillName="综合命理分析系统", level=2)\`\n\n---\n\n`;
    } catch (e) {
        logger.warn('Failed to load Skills metadata:', e);
        return '';
    }
}

/**
 * 递归加载节点及其子节点的内容（多层级结构，支持按层级加载）
 * @param maxLevel 最大加载层级，-1 表示加载所有层级
 */
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
    
    // 如果设置了最大层级，且当前层级超过最大层级，则停止加载
    if (maxLevel >= 0 && level > maxLevel) {
        return '';
    }
    
    const indent = '  '.repeat(level);
    let content = '';
    
    // 加载该节点的 cards
    const nodeCards = await CardModel.getByNodeId(domainId, baseDocId, nodeId);
    if (nodeCards.length > 0) {
        for (const card of nodeCards) {
            const { metadata, instructions } = parseSkillMd(card.content || '');
            const cardTitle = metadata.name || card.title || node.text;
            
            if (level === 0) {
                // Level 0 是根节点，跳过
                continue;
            } else if (level === 1) {
                // Level 1 是 skill 节点
                content += `\n\n# ${cardTitle}\n\n`;
                if (metadata.description) {
                    content += `${metadata.description}\n\n`;
                }
                // 如果 maxLevel 是 1，只加载描述，不加载详细内容
                if (instructions && (maxLevel < 0 || maxLevel >= 2)) {
                    content += `${instructions}\n\n`;
                }
            } else {
                // Level 2+ 是模块/子模块
                const headingLevel = level === 2 ? '##' : level === 3 ? '###' : '####';
                content += `\n${indent}${headingLevel} ${cardTitle}\n\n`;
                
                // 如果当前层级等于 maxLevel，只加载元数据和子模块列表，不加载详细内容
                if (maxLevel >= 0 && level === maxLevel) {
                    // 只加载描述和子模块列表
                    if (metadata.description) {
                        content += `${indent}${metadata.description}\n\n`;
                    }
                    // 列出子模块
                    const children = childrenMap.get(nodeId) || [];
                    if (children.length > 0) {
                        content += `${indent}**子模块列表：**\n`;
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
                    // 加载完整内容
                    if (metadata.description) {
                        content += `${indent}${metadata.description}\n\n`;
                    }
                    if (instructions) {
                        // 为子模块内容添加缩进
                        const indentedInstructions = instructions.split('\n')
                            .map(line => line.trim() ? `${indent}${line}` : '')
                            .join('\n');
                        content += `${indentedInstructions}\n\n`;
                    }
                }
            }
        }
    } else if (node.text) {
        // 如果没有 card，使用 node 的 text
        if (level === 1) {
            content += `\n\n# ${node.text}\n\n`;
        } else {
            // 支持任意层级：level 2 = ##, level 3 = ###, level 4 = ####, 以此类推
            // Markdown 最多支持 6 级标题，超过 6 级统一使用 ######
            const headingLevel = Math.min(level + 1, 6);
            const headingMark = '#'.repeat(headingLevel);
            content += `\n${indent}${headingMark} ${node.text}\n\n`;
            
            // 如果当前层级等于 maxLevel，列出子模块
            if (maxLevel >= 0 && level === maxLevel) {
                const children = childrenMap.get(nodeId) || [];
                if (children.length > 0) {
                    content += `${indent}**子模块列表：**\n`;
                    for (const child of children) {
                        content += `${indent}- ${child.text}\n`;
                    }
                    content += '\n';
                }
            }
        }
    }
    
    // 递归加载子节点（如果还没到最大层级）
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

/**
 * 加载指定 skill 的 instructions（按需加载 - 支持多层级结构）
 * @param skillName skill 名称
 * @param maxLevel 最大加载层级：
 *   - 1: 只加载 skill 概述（名称、描述、简短概述）
 *   - 2+: 加载到指定层级（该层级只显示子模块列表，不包含详细内容）
 *   - -1: 加载所有层级（完整内容）
 *   支持任意层级深度，不限制在 1、2、3 层
 */
export async function loadSkillInstructions(domainId: string, skillName: string, maxLevel: number = -1): Promise<string | null> {
    try {
        // 获取 Skills Base
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' })
            .limit(1)
            .toArray();
        
        if (skillsBaseList.length === 0) {
            return null;
        }
        
        const skillsBase = skillsBaseList[0] as any;
        const branchData = skillsBase.branchData?.['main'] || { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] };
        const nodes: BaseNode[] = branchData.nodes || [];
        const edges: BaseEdge[] = branchData.edges || [];
        
        // 构建节点树
        const childrenMap = buildNodeTree(nodes, edges);
        
        // 找到根节点
        const rootNodes = nodes.filter(n => (n.level === 0 || !n.parentId) && 
            !edges.some(e => e.target === n.id));
        
        if (rootNodes.length === 0) {
            return null;
        }
        
        const rootNode = rootNodes[0];
        
        // 查找匹配的 Level 1 skill 节点
        const skillNodes = childrenMap.get(rootNode.id) || 
            nodes.filter(n => n.parentId === rootNode.id || 
                edges.some(e => e.source === rootNode.id && e.target === n.id));
        
        for (const skillNode of skillNodes) {
            // 检查 skill 节点的名称（从 card 或 node text 中获取）
            const nodeCards = await CardModel.getByNodeId(domainId, skillsBase.docId, skillNode.id);
            let skillNodeName = skillNode.text;
            
            if (nodeCards.length > 0) {
                const { metadata } = parseSkillMd(nodeCards[0].content || '');
                skillNodeName = metadata.name || skillNode.text || nodeCards[0].title;
            }
            
            // 模糊匹配 skill 名称
            if (skillNodeName.toLowerCase().includes(skillName.toLowerCase()) || 
                skillName.toLowerCase().includes(skillNodeName.toLowerCase())) {
                
                // 递归加载该 skill 及其子节点的内容（按 maxLevel 控制层级）
                const fullContent = await loadNodeContentRecursive(
                    domainId,
                    skillsBase.docId,
                    skillNode.id,
                    nodes,
                    childrenMap,
                    1, // Level 1
                    maxLevel
                );
                
                return fullContent ? `\n\n${fullContent}\n\n---\n\n` : null;
            }
        }
        
        return null;
    } catch (e) {
        logger.warn(`Failed to load skill instructions for ${skillName}:`, e);
        return null;
    }
}

/**
 * 加载指定 skill 到 Level 2（只加载模块列表，不加载详细内容）
 * 用于渐进式披露，节省 token
 */
export async function loadSkillToLevel2(domainId: string, skillName: string): Promise<string | null> {
    return loadSkillInstructions(domainId, skillName, 2);
}

/**
 * 加载指定 skill 到 Level 3（加载模块和子模块列表，不加载详细内容）
 * 用于渐进式披露，节省 token
 */
export async function loadSkillToLevel3(domainId: string, skillName: string): Promise<string | null> {
    return loadSkillInstructions(domainId, skillName, 3);
}

/**
 * 加载指定 skill 的完整内容（所有层级）
 */
export async function loadSkillFull(domainId: string, skillName: string): Promise<string | null> {
    return loadSkillInstructions(domainId, skillName, -1);
}

/**
 * 加载 domain 的所有 Skills（从 Base 的 Cards 中加载）
 * 返回格式化的字符串，可以直接添加到 system message
 * 
 * @deprecated 建议使用 loadSkillsMetadata() 实现渐进式披露，节省 token
 */
export async function loadSkillsInstructions(domainId: string): Promise<string> {
    try {
        // 获取 Skills Base（type='skill'）
        const skillsBaseList = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' })
            .limit(1)
            .toArray();
        
        if (skillsBaseList.length === 0) {
            return '';
        }
        
        const skillsBase = skillsBaseList[0] as any;
        
        // 获取所有 nodes 下的 cards（这些就是 Skills）
        const branchData = skillsBase.branchData?.['main'] || { nodes: skillsBase.nodes || [], edges: skillsBase.edges || [] };
        const nodes: BaseNode[] = branchData.nodes || [];
        
        if (nodes.length === 0) {
            return '';
        }
        
        // 获取所有 cards（Skills）- 从 Skills Base 的所有 nodes 中获取
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
        
        // 格式化为 system message 的一部分
        const skillsText = validSkills.map(skill => {
            return `## ${skill.name}\n\n${skill.description ? skill.description + '\n\n' : ''}${skill.instructions}`;
        }).join('\n\n---\n\n');
        
        return `\n\n# Agent Skills\n\nThe following Agent Skills are available and should be used when relevant:\n\n${skillsText}\n\n---\n\n`;
    } catch (e) {
        logger.warn('Failed to load Skills:', e);
        return '';
    }
}

