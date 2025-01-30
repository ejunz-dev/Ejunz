import {
    _, Context, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,ValidationError,encodeRFC5987ValueChars,
    param, PRIV, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError,DiscussionNotFoundError,buildProjection,PERM
} from 'ejun';
import { lookup } from 'mime-types';


export const TYPE_NODE: 111 = 111;
export interface NodeDoc {
    docType: 111;
    docId: number;
    domainId: string,
    nid: string;
    owner: number;
    content: string;
    title: string;
    ip: string;
    updateAt: Date;
    nReply: number;
    views: number;
    reply: any[];
    react: Record<string, number>;
    files: {
        filename: string;           
        version: string;
        path: string;            
        size: number;           
        lastModified: Date;      
        etag?: string;        
    }[];
}                                   


declare module 'ejun' {
    interface Model {
        node: typeof NodeModel;
    }
    interface DocType {
        [TYPE_NODE]: NodeDoc;
    }
}


export class NodeModel {
    static PROJECTION_LIST: Field[] = [
        'docId', 'nid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','files'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...NodeModel.PROJECTION_LIST,
       'docId', 'nid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','files'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...NodeModel.PROJECTION_DETAIL,
        'docId', 'nid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','files'
    ];

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastNode = await DocumentModel.getMulti(domainId, TYPE_NODE, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();

        const lastDocId = Number(lastNode[0]?.docId) || 0;
        return lastDocId + 1;
    }

    static async generateNextnid(domainId: string): Promise<string> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_NODE, {})
            .sort({ nid: -1 })
            .limit(1)
            .project({ nid: 1 })
            .toArray();

        if (!lastDoc.length || !lastDoc[0]?.nid) {
            return "N1";
        }

        const lastnid = String(lastDoc[0].nid);
        const lastnidNumber = parseInt(lastnid.match(/\d+/)?.[0] || "0", 10);

        return `N${lastnidNumber + 1}`;
    }

    static async addWithId(
        domainId: string,
        docId: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<NodeDoc> = {},
    ): Promise<string> {
        const nid = await NodeModel.generateNextnid(domainId);

        if (typeof ip !== 'string') {
            ip = String(ip);
        }

        const payload: Partial<NodeDoc> = {
            domainId,
            docId,
            nid,
            content,
            owner,
            title: String(title),
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, 
        };

        await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_NODE,
            docId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        return nid;
    }

    static async add(
        domainId: string, owner: number, title: string, content: string, ip?: string,
    ): Promise<string> {
        const docId = await NodeModel.generateNextDocId(domainId);
        return NodeModel.addWithId(domainId, docId, owner, title, content, ip);
    }

    static async getBynid(domainId: string, nid: string): Promise<NodeDoc | null> {
        const query = /^\d+$/.test(nid) ? { docId: Number(nid) } : { nid };
    
        console.log(`[NodeModel.getBynid] Querying nodesitory with`, query);
    
        const doc = await DocumentModel.getMulti(domainId, TYPE_NODE, query)
            .project<NodeDoc>(buildProjection(NodeModel.PROJECTION_DETAIL)) 
            .limit(1)
            .next();
    
        if (!doc) {
            console.warn(`[NodeModel.getBynid] No document found for query=`, query);
        } else {
            console.log(`[NodeModel.getBynid] Retrieved document:`, JSON.stringify(doc, null, 2));
        }
    
        return doc || null;
    }
    

    static async get(domainId: string, nid: number | string): Promise<NodeDoc | null> {
        const query = typeof nid === 'number' ? { docId: nid } : { nid: String(nid) };

        console.log(`[NodeModel.get] Querying document with ${typeof nid === 'number' ? 'docId' : 'nid'}=${nid}`);

        const res = await DocumentModel.getMulti(domainId, TYPE_NODE, query)
            .project({ files: 1, nid: 1, title: 1, content: 1, docId: 1 })
            .limit(1)
            .toArray();

        if (!res.length) {
            console.error(`[NodeModel.get] No document found for ${typeof nid === 'number' ? 'docId' : 'nid'}=${nid}`);
            return null;
        }

        const nodeDoc = res[0] as NodeDoc;

        if (!Array.isArray(nodeDoc.files)) {
            console.warn(`[NodeModel.get] Warning: nodeDoc.files is not an array, resetting to empty array.`);
            nodeDoc.files = [];
        }

        console.log(`[NodeModel.get] Retrieved document:`, JSON.stringify(nodeDoc, null, 2));

        return nodeDoc;
    }

    static getMulti(domainId: string, query: Filter<NodeDoc> = {}, projection = NodeModel.PROJECTION_LIST) {
        return DocumentModel.getMulti(domainId, TYPE_NODE, query, projection).sort({ docId: -1 });
    }

    static async list(
        domainId: string,
        query: Filter<NodeDoc>,
        page: number,
        pageSize: number,
        projection = NodeModel.PROJECTION_LIST,
        uid?: number
    ): Promise<[NodeDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union?.union || [])];

        let totalCount = 0;
        const nodeList: NodeDoc[] = [];

        for (const id of domainIds) {
            if (typeof uid === 'number') {
                const userDoc = await UserModel.getById(id, uid);
                if (!userDoc.hasPerm(PERM.PERM_VIEW)) continue;
            }

            const currentCount = await DocumentModel.count(id, TYPE_NODE, query);

            if (nodeList.length < pageSize && (page - 1) * pageSize - totalCount <= currentCount) {
                nodeList.push(
                    ...await DocumentModel.getMulti(id, TYPE_NODE, query, projection)
                        .sort({ docId: -1 })
                        .skip(Math.max((page - 1) * pageSize - totalCount, 0))
                        .limit(pageSize - nodeList.length)
                        .toArray()
                );
            }

            totalCount += currentCount;
        }

        return [nodeList, Math.ceil(totalCount / pageSize), totalCount];
    }
    static async getList(
        domainId: string, 
        docIds: number[],
        projection = NodeModel.PROJECTION_PUBLIC, 
        indexByDocIdOnly = false,
    ): Promise<Record<number | string, NodeDoc>> {
        if (!docIds?.length) {
            return {};
        }
    
        const r: Record<number, NodeDoc> = {};
        const l: Record<string, NodeDoc> = {};
    
        const q: any = { docId: { $in: docIds } };
    
        let nodes = await DocumentModel.getMulti(domainId, TYPE_NODE, q)
            .project<NodeDoc>(buildProjection(projection))
            .toArray();
    
        for (const node of nodes) {
            r[node.docId] = node;
            if (node.nid) l[node.nid] = node;
        }
    
        return indexByDocIdOnly ? r : Object.assign(r, l);
    }
    
    static async edit(domainId: string, nid: string, updates: Partial<NodeDoc>): Promise<NodeDoc> {
        const node = await DocumentModel.getMulti(domainId, TYPE_NODE, { nid }).next();
        if (!node) throw new Error(`Document with nid=${nid} not found`);

        return DocumentModel.set(domainId, TYPE_NODE, node.docId, updates);
    }

    static async addVersion(
        domainId: string,
        docId: number,
        filename: string,
        version: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string
    ): Promise<NodeDoc> {
        const nodeDoc = await NodeModel.get(domainId, docId);
        if (!nodeDoc) throw new Error(`Nodesitory with docId=${docId} not found`);

        const payload = {
            filename,
            version,
            path,
            size,
            lastModified,
            etag,
        };

        const [updatedNode] = await DocumentModel.push(domainId, TYPE_NODE, docId, 'files', payload);

        return updatedNode;
    }

    static async inc(domainId: string, nid: string, key: NumberKeys<NodeDoc>, value: number): Promise<NodeDoc | null> {
        const doc = await NodeModel.getBynid(domainId, nid);
        if (!doc) throw new Error(`Nodesitory with nid=${nid} not found`);

        return DocumentModel.inc(domainId, TYPE_NODE, doc.docId, key, value);
    }

    static async del(domainId: string, nid: string): Promise<boolean> {
        const doc = await NodeModel.getBynid(domainId, nid);
        if (!doc) throw new Error(`Nodesitory with nid=${nid} not found`);

        await Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_NODE, doc.docId),
            DocumentModel.deleteMultiStatus(domainId, TYPE_NODE, { docId: doc.docId }),
        ]);
        return true;
    }

    static async count(domainId: string, query: Filter<NodeDoc>) {
        return DocumentModel.count(domainId, TYPE_NODE, query);
    }

    static async setStar(domainId: string, nid: string, uid: number, star: boolean) {
        const doc = await NodeModel.getBynid(domainId, nid);
        if (!doc) throw new Error(`Nodesitory with nid=${nid} not found`);

        return DocumentModel.setStatus(domainId, TYPE_NODE, doc.docId, uid, { star });
    }

    static async getStatus(domainId: string, nid: string, uid: number) {
        const doc = await NodeModel.getBynid(domainId, nid);
        if (!doc) throw new Error(`Nodesitory with nid=${nid} not found`);

        return DocumentModel.getStatus(domainId, TYPE_NODE, doc.docId, uid);
    }

    static async setStatus(domainId: string, nid: string, uid: number, updates) {
        const doc = await NodeModel.getBynid(domainId, nid);
        if (!doc) throw new Error(`Nodesitory with nid=${nid} not found`);

        return DocumentModel.setStatus(domainId, TYPE_NODE, doc.docId, uid, updates);
    }
}


global.Ejunz.model.node = NodeModel;


class NodeHandler extends Handler {
    ddoc?: NodeDoc;

     @param('nid', Types.NodeId, true)
    async _prepare(domainId: string, nid?: string) {
        if (!nid || nid === 'create') return; 

        const normalizedId: number | string = /^\d+$/.test(nid) ? Number(nid) : nid;
        console.log(`[NodeHandler] Querying nodesitory with ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);

        this.ddoc = await NodeModel.get(domainId, normalizedId);
        if (!this.ddoc) {
            console.error(`[NodeHandler] Nodesitory not found for ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);
            throw new NotFoundError(`Nodesitory not found for ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);
        }
    }
}



export class NodeDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId;

        try {
            const domainInfo = await DomainModel.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain not found for ID: ${domainId}`);

            const allNodes = await NodeModel.getMulti(domainId, {}).toArray();

            const totalCount = allNodes.length;
            const totalPages = Math.ceil(totalCount / pageSize);
            const currentPage = Math.max(1, Math.min(page, totalPages));
            const startIndex = (currentPage - 1) * pageSize;
            const paginatedNodes = allNodes.slice(startIndex, startIndex + pageSize);

            this.response.template = 'node_domain.html';
            this.response.body = {
                domainId,
                ndocs: paginatedNodes,
                page: currentPage,
                totalPages,
                totalCount,
            };
            console.log(`ndocs`, paginatedNodes);
        
            
        } catch (error) {
            console.error('Error in fetching Nodes:', error);
            this.response.template = 'error.html';
            this.response.body = { error: 'Failed to fetch nodesitories.' };
        }
    }
}

export class NodeDetailHandler extends Handler {
    ddoc?: NodeDoc;

    @param('nid', Types.NodeId)
    async _prepare(domainId: string, nid: string) {
        if (!nid) return;

        const normalizedId: number | string = /^\d+$/.test(nid) ? Number(nid) : nid;
        console.log(`[NodeDetailHandler] Querying document with ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);

        this.ddoc = await NodeModel.get(domainId, normalizedId);
        if (!this.ddoc) {
            console.error(`[NodeDetailHandler] Nodesitory not found for ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);
            throw new NotFoundError(`Nodesitory not found for ${typeof normalizedId === 'number' ? 'docId' : 'nid'}: ${normalizedId}`);
        }
    }

    @param('nid', Types.NodeId)
    async get(domainId: string, nid: string) {
        const normalizedId: number | string = /^\d+$/.test(nid) ? Number(nid) : nid;

        console.log(`[NodeDetailHandler] Querying document with ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);

        const ddoc = await NodeModel.get(domainId, normalizedId);
        if (!ddoc) {
            throw new NotFoundError(`Nodesitory not found for ${typeof normalizedId === 'number' ? 'docId' : 'nid'}: ${normalizedId}`);
        }

        if (!Array.isArray(ddoc.files)) {
            console.warn(`[NodeDetailHandler] Warning: ddoc.files is not an array, resetting to empty array.`);
            ddoc.files = [];
        }

        console.log(`[NodeDetailHandler] Retrieved files:`, JSON.stringify(ddoc.files, null, 2));

        this.response.template = 'node_detail.html';
        this.response.body = {
            domainId,
            nid: ddoc.nid, 
            ddoc,
            files: ddoc.files, 
        };
    }
}





export class NodeEditHandler extends NodeHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';

        if (!this.ddoc) {
            console.warn(`[NodeEditHandler.get] No ddoc found, skipping node_edit.`);
            this.response.template = 'node_edit.html';
            this.response.body = { ddoc: null, files: [], urlForFile: null };
            return;
        }
    
        const docId = this.ddoc?.docId;
        if (!docId) {
            throw new ValidationError('Missing docId');
        }
    
        const files = await StorageModel.list(`node/${domainId}/${docId}`);
        const urlForFile = (filename: string) => `/d/${domainId}/${docId}/${filename}`;
    
        this.response.template = 'node_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile,
        };
    }
    

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('filename', Types.String)
    @param('version', Types.String)
    async postCreate(
        domainId: string,
        title: string,
        content: string,
        filename: string,
        version: string,
    ) {
        await this.limitRate('add_node', 3600, 60);
    
        const file = this.request.files?.file;
        if (!file) {
            throw new ValidationError('A file must be uploaded to create a node.');
        }
    
        const domainInfo = await DomainModel.get(domainId);
        if (!domainInfo) {
            throw new NotFoundError('Domain not found.');
        }
    
        const docId = await NodeModel.generateNextDocId(domainId);
        console.log(`[NodeEditHandler] Created new docId=${docId}`);
    
        const providedFilename = filename || file.originalFilename;
        const filePath = `node/${domainId}/${docId}/${providedFilename}`;
    
        await StorageModel.put(filePath, file.filepath, this.user._id);
        const fileMeta = await StorageModel.getMeta(filePath);
        if (!fileMeta) {
            throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
        }
    
        const fileData = {
            filename: providedFilename ?? 'unknown_file',
            version: version ?? '0.0.0',
            path: filePath,
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };
    
        const nid = await NodeModel.addWithId(
            domainId,
            docId,
            this.user._id,
            title,
            content,
            this.request.ip,
            { files: [fileData] }
        );
        console.log(`[NodeEditHandler] Created nodesitory: docId=${docId}, nid=${nid}`);
        
        this.response.body = { nid };
        this.response.redirect = this.url('node_detail', { uid: this.user._id, nid });
    }
    
    @param('nid', Types.NodeId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, nid: string, title: string, content: string) {
        const normalizedId: number | string = /^\d+$/.test(nid) ? Number(nid) : nid;
    
        console.log(`[NodeEditHandler] Updating node with ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);
    
        const node = await NodeModel.get(domainId, normalizedId);
        if (!node) {
            throw new NotFoundError(`Nodesitory not found for ${typeof normalizedId === 'number' ? 'docId' : 'nid'}=${normalizedId}`);
        }
    
        const nodenid = node.nid;
        const updatedNode = await NodeModel.edit(domainId, nodenid, { title, content });
    
        console.log('Node updated successfully:', updatedNode);
    
        this.response.body = { nid: nodenid };
        this.response.redirect = this.url('node_detail', { uid: this.user._id, nid: nodenid });
    }
    

}



export class NodeVersionHandler extends Handler {
   @param('nid', Types.NodeId, true) 
    async get(domainId: string, nid: string) {
        const node = await NodeModel.getBynid(domainId, nid);
        if (!node) throw new NotFoundError(`Nodesitory not found for NID: ${nid}`);

        this.response.template = 'node_version.html';
        this.response.body = {
            ddoc: node,
            domainId,
        };
    }

   @param('nid', Types.NodeId, true)
    @param('filename', Types.String, true)
    @param('version', Types.String, true)
    async post(domainId: string, nid: string, filename: string, version: string) {
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('A file must be uploaded.');

        const node = await NodeModel.getBynid(domainId, nid);
        if (!node) throw new NotFoundError(`Nodesitory not found for NID: ${nid}`);

        const docId = node.docId;
        if (typeof docId !== 'number') {
            throw new Error(`Expected docId to be a number, but got ${typeof docId}`);
        }

        const filePath = `node/${domainId}/${docId}/${filename}`;
        await StorageModel.put(filePath, file.filepath, this.user._id);
        const fileMeta = await StorageModel.getMeta(filePath);
        if (!fileMeta) throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);

        const fileData = {
            filename,
            version,
            path: filePath, 
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };

        await NodeModel.addVersion(
            domainId,
            node.docId,
            fileData.filename,
            fileData.version,
            fileData.path,
            fileData.size,
            fileData.lastModified,
            fileData.etag
        );
        

        console.log('Version added successfully:', fileData);

        this.response.redirect = this.url('node_detail', { domainId, nid });
    }
}


export class NodeHistoryHandler extends Handler {
    @param('nid', Types.NodeId, true) 
    async get(domainId: string, nid: string) {
        console.log(`[NodeHistoryHandler] Querying nodesitory with nid=${nid}`);

        const node = await NodeModel.getBynid(domainId, nid);
        if (!node) {
            console.error(`[NodeHistoryHandler] Nodesitory not found for NID: ${nid}`);
            throw new NotFoundError(`Nodesitory not found for NID: ${nid}`);
        }

        const nodenid = node.nid ?? String(node.docId);
        console.log(`[NodeHistoryHandler] Using nid=${nodenid}`);

        const sortedFiles = (node.files || [])
            .map(file => ({
                ...file,
                lastModified: new Date(file.lastModified),
            }))
            .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

        if (!sortedFiles.length) {
            console.warn(`[NodeHistoryHandler] No files found in node=${nodenid}`);
            throw new NotFoundError('No files found in the nodesitory.');
        }

        this.response.template = 'node_history.html';
        this.response.body = {
            ddoc: node,
            domainId,
            nid: nodenid, 
            files: sortedFiles,
            urlForFile: (filename: string) => this.url('node_file_download', { domainId, nid: nodenid, filename }), // ✅ 确保 nid 是字符串
        };
        console.log('files', sortedFiles);
        console.log('node', node);
    }
}

export class NodefileDownloadHandler extends Handler {
    async get({ nid, filename }: { nid: string; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';

        const node = await NodeModel.getBynid(domainId, nid);
        if (!node) throw new NotFoundError(`Nodesitory not found for NID: ${nid}`);

        const docId = node.docId ?? nid;  
        const filePath = `node/${domainId}/${docId}/${filename}`;

        console.log(`[NodefileDownloadHandler] Checking filePath=${filePath}`);

        const fileMeta = await StorageModel.getMeta(filePath);
        if (!fileMeta) throw new NotFoundError(`File "${filename}" does not exist in nodesitory "${nid}".`);

        this.response.body = await StorageModel.get(filePath);
        this.response.type = lookup(filename) || 'application/octet-stream';

        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(this.response.type)) {
            this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}


    
    






export async function apply(ctx: Context) {
    ctx.Route('node_domain', '/node', NodeDomainHandler);
    ctx.Route('node_create', '/node/create', NodeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_detail', '/node/:nid', NodeDetailHandler);
    ctx.Route('node_edit', '/node/:nid/edit', NodeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_add_version', '/node/:nid/add-version', NodeVersionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_history', '/node/:nid/history', NodeHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_file_download', '/node/:nid/file/:filename', NodefileDownloadHandler, PRIV.PRIV_USER_PROFILE);

    
    ctx.injectUI('Nav', 'node_domain', () => ({
        name: 'node_domain',
        displayName: 'Node',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));

    ctx.i18n.load('en', {
        node_domain: 'Nodesitory',
        node_detail: 'Nodesitory Detail',
        node_edit: 'Edit Nodesitory',
    });
    ctx.i18n.load('zh', {
        node_domain: '资料库',
        node_detail: '资料详情',
        node_edit: '编辑资料',
    });
    ctx.inject(['api'], ({ api }) => {
        api.value('Node', [
            ['docId', 'Int!'],
            ['nid', 'String!'],
            ['title', 'String!'],
            ['content', 'String!'],
            ['owner', 'Int!'],
            ['updateAt', 'String!'],
            ['views', 'Int!'],
            ['nReply', 'Int!'],
            ['files', '[File!]'],
        ]);

        api.value('File', [
            ['filename', 'String!'],
            ['version', 'String!'],
            ['path', 'String!'],
            ['size', 'Int!'],
            ['lastModified', 'String!'],
            ['etag', 'String!'],
        ]);

        api.resolver(
            'Query', 'node(id: Int, title: String)', 'Node',
            async (arg, c) => {
                c.checkPerm(PERM.PERM_VIEW);
                const ndoc = await NodeModel.get(c.args.domainId, arg.title || arg.id);
                if (!ndoc) return null;
                c.ndoc = ndoc;
                return ndoc;
            },
        );
        api.resolver('Query', 'nodes(ids: [Int])', '[Node]', async (arg, c) => {
            c.checkPerm(PERM.PERM_VIEW);
            const res = await NodeModel.getList(c.args.domainId, arg.ids, undefined);
            return Object.keys(res)
                .map((id) => res[+id])
                .filter((node) => node !== null && node !== undefined); 
        }, 'Get a list of docs by ids');
        

    });
}
