import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, Types } from '../service/server';
import { NotFoundError, ForbiddenError } from '../error';
import { PRIV, PERM } from '../model/builtin';
import { MindMapModel } from '../model/mindmap';
import type { MindMapDoc, MindMapNode, MindMapEdge } from '../interface';
import * as document from '../model/document';

/**
 * MindMap Detail Handler
 */
class MindMapDetailHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, mmid: number) {
        const path = this.request.path || '';
        if (path.endsWith('.css.map') || path.endsWith('.js.map') || path.endsWith('.map')) {
            throw new NotFoundError('Static resource');
        }
        
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else if (mmid) {
            this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
        
        await MindMapModel.incrementViews(domainId, this.mindMap.docId);
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async get(domainId: string, docId: ObjectId, mmid: number) {
        this.response.template = 'mindmap_detail.html';
        this.response.body = {
            mindMap: this.mindMap,
        };
    }

}

/**
 * MindMap Create Handler
 */
class MindMapCreateHandler extends Handler {
    async get() {
        this.response.template = 'mindmap_create.html';
        this.response.body = {};
    }

    @param('title', Types.String)
    @param('content', Types.String, true)
    @param('rpid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(
        domainId: string,
        title: string,
        content: string = '',
        rpid?: number,
        branch?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const { docId, mmid } = await MindMapModel.create(
            domainId,
            this.user._id,
            title,
            content,
            rpid,
            branch,
            this.request.ip
        );

        this.response.body = { docId, mmid };
        this.response.redirect = this.url('mindmap_detail', { docId: docId.toString() });
    }
}

/**
 * MindMap Edit Handler
 */
class MindMapEditHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId)
    async _prepare(domainId: string, docId: ObjectId) {
        this.mindMap = await MindMapModel.get(domainId, docId);
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
        
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    async get() {
        this.response.template = 'mindmap_edit.html';
        this.response.body = { mindMap: this.mindMap };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        title?: string,
        content?: string
    ) {
        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;

        await MindMapModel.update(domainId, docId, updates);
        this.response.body = { docId };
        this.response.redirect = this.url('mindmap_detail', { docId: docId.toString() });
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        // 检查权限
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }
        
        await MindMapModel.delete(domainId, docId);
        this.response.body = { success: true };
        this.response.redirect = this.url('mindmap_list');
    }
}

/**
 * MindMap Node Handler
 * 节点操作API
 */
class MindMapNodeHandler extends Handler {
    @param('docId', Types.ObjectId)
    @param('text', Types.String)
    @param('x', Types.Float, true)
    @param('y', Types.Float, true)
    @param('parentId', Types.String, true)
    @param('siblingId', Types.String, true)
    async postAdd(
        domainId: string,
        docId: ObjectId,
        text: string,
        x?: number,
        y?: number,
        parentId?: string,
        siblingId?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        let effectiveParentId: string | undefined = parentId;

        if (siblingId && !parentId) {
            const siblingNode = mindMap.nodes.find(n => n.id === siblingId);
            if (!siblingNode) {
                throw new NotFoundError(`Sibling node not found: ${siblingId}`);
            }
            effectiveParentId = siblingNode.parentId;
        }

        const node: Omit<MindMapNode, 'id'> = {
            text,
            x,
            y,
            parentId: effectiveParentId,
        };

        const newNodeId = await MindMapModel.addNode(
            domainId,
            docId,
            node,
            effectiveParentId
        );

        let edgeSourceId: string;
        let edgeTargetId: string;

        if (siblingId && !parentId) {
            if (!effectiveParentId) {
                this.response.body = { nodeId: newNodeId };
                return;
            }
            edgeSourceId = effectiveParentId;
            edgeTargetId = newNodeId;
        } else if (parentId) {
            edgeSourceId = parentId;
            edgeTargetId = newNodeId;
        } else {
            this.response.body = { nodeId: newNodeId };
            return;
        }

        let edgeId: string | undefined;
        try {
            edgeId = await MindMapModel.addEdge(domainId, docId, {
                source: edgeSourceId,
                target: edgeTargetId,
            });
        } catch (error: any) {
            if (error.message?.includes('already exists')) {
                const mindMapAfter = await MindMapModel.get(domainId, docId);
                const existingEdge = mindMapAfter?.edges.find(
                    e => e.source === edgeSourceId && e.target === edgeTargetId
                );
                if (existingEdge) {
                    edgeId = existingEdge.id;
                }
            } else {
                throw error;
            }
        }

        this.response.body = { 
            nodeId: newNodeId,
            edgeId: edgeId,
            edgeSource: edgeSourceId,
            edgeTarget: edgeTargetId,
        };
    }

    @param('docId', Types.ObjectId)
    @param('nodeId', Types.String)
    @param('text', Types.String, true)
    @param('color', Types.String, true)
    @param('backgroundColor', Types.String, true)
    @param('fontSize', Types.Int, true)
    @param('x', Types.Float, true)
    @param('y', Types.Float, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        nodeId: string,
        text?: string,
        color?: string,
        backgroundColor?: string,
        fontSize?: number,
        x?: number,
        y?: number
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const updates: Partial<MindMapNode> = {};
        if (text !== undefined) updates.text = text;
        if (color !== undefined) updates.color = color;
        if (backgroundColor !== undefined) updates.backgroundColor = backgroundColor;
        if (fontSize !== undefined) updates.fontSize = fontSize;
        if (x !== undefined) updates.x = x;
        if (y !== undefined) updates.y = y;

        await MindMapModel.updateNode(domainId, docId, nodeId, updates);
        this.response.body = { success: true };
    }

    @param('docId', Types.ObjectId)
    @param('nodeId', Types.String)
    async postDelete(domainId: string, docId: ObjectId, nodeId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        await MindMapModel.deleteNode(domainId, docId, nodeId);
        this.response.body = { success: true };
    }
}

/**
 * MindMap Edge Handler
 */
class MindMapEdgeHandler extends Handler {
    @param('docId', Types.ObjectId)
    @param('source', Types.String)
    @param('target', Types.String)
    @param('label', Types.String, true)
    async postAdd(
        domainId: string,
        docId: ObjectId,
        source: string,
        target: string,
        label?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const edge: Omit<MindMapEdge, 'id'> = {
            source,
            target,
            label,
        };

        const newEdgeId = await MindMapModel.addEdge(
            domainId,
            docId,
            edge
        );

        this.response.body = { edgeId: newEdgeId };
    }

    @param('docId', Types.ObjectId)
    @param('edgeId', Types.String)
    async postDelete(domainId: string, docId: ObjectId, edgeId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        await MindMapModel.deleteEdge(domainId, docId, edgeId);
        this.response.body = { success: true };
    }
}

/**
 * MindMap Save Handler
 */
class MindMapSaveHandler extends Handler {
    @param('docId', Types.ObjectId)
    async post(domainId: string, docId: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const data = this.request.body || {};
        const { nodes, edges, layout, viewport, theme } = data;

        await MindMapModel.updateFull(domainId, docId, {
            nodes,
            edges,
            layout,
            viewport,
            theme,
        });
        this.response.body = { success: true };
    }
}

/**
 * MindMap List Handler
 */
class MindMapListHandler extends Handler {
    @param('rpid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid?: number, branch?: string) {
        let mindMaps: MindMapDoc[];
        
        if (rpid) {
            mindMaps = await MindMapModel.getByRepo(domainId, rpid, branch);
        } else {
            mindMaps = await MindMapModel.getAll(domainId);
        }

        this.response.template = 'mindmap_list.html';
        this.response.body = { mindMaps, rpid, branch };
    }
}

/**
 * MindMap Domain Handler
 */
class MindMapDomainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    async get(domainId: string, page = 1, q = '') {
        let mindMaps = await MindMapModel.getAll(domainId);
        
        // 搜索过滤
        if (q && q.trim()) {
            const searchTerm = q.trim().toLowerCase();
            mindMaps = mindMaps.filter(mindMap => 
                mindMap.title.toLowerCase().includes(searchTerm) ||
                (mindMap.content && mindMap.content.toLowerCase().includes(searchTerm)) ||
                String(mindMap.mmid).includes(searchTerm)
            );
        }
        
        // 按 mmid 排序
        mindMaps.sort((a, b) => (a.mmid || 0) - (b.mmid || 0));
        
        // 计算统计信息
        const totalNodes = mindMaps.reduce((sum, mm) => sum + (mm.nodes?.length || 0), 0);
        const totalViews = mindMaps.reduce((sum, mm) => sum + (mm.views || 0), 0);
        
        this.response.template = 'mindmap_domain.html';
        this.response.body = { 
            mindMaps, 
            domainId,
            page,
            qs: q,
            totalNodes,
            totalViews,
        };
    }
}

class MindMapDataHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, mmid: number) {
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else if (mmid) {
            this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async get(domainId: string, docId: ObjectId, mmid: number) {
        this.response.body = this.mindMap;
    }
}

export async function apply(ctx: Context) {
    // 注册路由
    ctx.Route('mindmap_domain', '/mindmap', MindMapDomainHandler);
    ctx.Route('mindmap_list', '/mindmap/list', MindMapListHandler);
    ctx.Route('mindmap_create', '/mindmap/create', MindMapCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_detail', '/mindmap/:docId', MindMapDetailHandler);
    ctx.Route('mindmap_detail_mmid', '/mindmap/mmid/:mmid', MindMapDetailHandler);
    ctx.Route('mindmap_data', '/mindmap/:docId/data', MindMapDataHandler);
    ctx.Route('mindmap_data_mmid', '/mindmap/mmid/:mmid/data', MindMapDataHandler);
    ctx.Route('mindmap_edit', '/mindmap/:docId/edit', MindMapEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_node', '/mindmap/:docId/node', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_node_update', '/mindmap/:docId/node/:nodeId', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_edge', '/mindmap/:docId/edge', MindMapEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_save', '/mindmap/:docId/save', MindMapSaveHandler, PRIV.PRIV_USER_PROFILE);
}

