import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { NotFoundError } from '../error';
import { Handler, param, Types } from '../service/server';
import { PERM, PRIV } from '../model/builtin';
import user from '../model/user';
import domain from '../model/domain';
import { 
    ForestModel, TreeModel, BranchModel, 
    FRDoc, TRDoc, BRDoc,
    getDocsByDocId, /* getReposByDocId, */ getProblemsByDocsId, getRelated 
} from '../model/tree';
import { encodeRFC5987ValueChars } from '../service/storage';
import storage from '../model/storage';
import { lookup } from 'mime-types';
// import RepoModel from '../model/repo'; // Removed: repo functionality moved to ejunzrepo plugin

class BranchHandler extends Handler {
    ddoc?: BRDoc;

    @param('docId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: ObjectId) {
        if (docId) {
            const branchDoc = await BranchModel.get(domainId, docId);
            if (!branchDoc) {
                throw new NotFoundError(domainId, docId);
            }
            this.ddoc = branchDoc;
        }
    }
}

export class ForestDomainHandler extends Handler {
    async get({ domainId }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';
  
        try {
            const forest = await ForestModel.getForest(domainId);
            const trees = await TreeModel.getAllTrees(domainId);
  
            const nodes = [
                {
                    id: "forest-root",
                    name: "Forest",
                    type: "forest",
                    url: this.url("forest_domain", { domainId })
                },
                ...trees.map(tree => ({
                    id: `tree-${tree.trid}`,
                    name: tree.title,
                    type: 'tree',
                    url: this.url('tree_detail', { domainId, trid: tree.trid }),
                }))
            ];
  
            const links = trees.map(tree => ({
                source: "forest-root",
                target: `tree-${tree.trid}`
            }));
  
            this.UiContext.forceGraphData = { nodes, links };
  
            this.response.template = 'forest_domain.html';
            this.response.body = {
                domainId,
                forest: forest || null,
                trees: trees || []
            };
        } catch (error) {
            console.error("Error fetching forest:", error);
            this.response.template = 'error.html';
            this.response.body = { error: "Failed to fetch forest" };
        }
    }
}

export class ForestEditHandler extends Handler {
    @param('docId', Types.ObjectId, true) 
    async get(domainId: string, docId?: ObjectId) {
        let forest = await ForestModel.getForest(domainId); 
        if (!forest) {
            console.warn(`No forest found for domain: ${domainId}`);
            forest = {
                docType: 7,
                domainId: domainId,
                docId: null as any,
                trids: [],
                title: '',
                content: '',
                owner: this.user._id,
                createdAt: new Date(),
                updateAt: new Date(),
            }; 
        }

        this.response.template = 'forest_edit.html';
        this.response.body = { forest };
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postCreate(domainId: string, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const docId = await ForestModel.createForest(domainId, this.user._id, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('forest_domain', { domainId });
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        await ForestModel.updateForest(domainId, docId, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('forest_domain', { domainId });
    }
}

export class TreeEditHandler extends Handler {
    @param('trid', Types.Int, true)
    async get(domainId: string, trid: number) {
        const tree = await TreeModel.getTreeByTrid(domainId, trid);

        this.response.template = 'tree_edit.html';
        this.response.body = { tree };
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postCreate(domainId: string, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
    
        if (!title.trim()) {
            throw new Error("Title cannot be empty.");
        }
    
        if (!content || typeof content !== 'string') {
            content = '';
        }
    
        const { docId, trid } = await TreeModel.createTree(domainId, this.user._id, title, content);
    
        this.response.body = { docId, trid };
        this.response.redirect = this.url('tree_detail', { domainId, trid }); 
    }

    @param('trid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, trid: number, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
    
        if (!title.trim()) {
            throw new Error("Title cannot be empty.");
        }
    
        if (!content || typeof content !== 'string') {
            content = '';
        }
    
        await TreeModel.edit(domainId, trid, title, content);
        this.response.body = { trid };
        this.response.redirect = this.url('tree_detail', { domainId, trid });
    }

    @param('trid', Types.Int)
    async postDelete(domainId: string, trid: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await TreeModel.deleteTree(domainId, trid);
        this.response.body = { trid };
        this.response.redirect = this.url('forest_domain', { domainId });
    }
}

export class TreeDetailHandler extends Handler {
    @param('trid', Types.Int)
    async get(domainId: string, trid: number) {
        if (!trid) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }
  
        // 获取树信息
        const tree = await TreeModel.getTreeByTrid(domainId, trid);
        if (!tree) {
            throw new NotFoundError(`Tree with docId ${trid} not found.`);
        }
  
        // 获取所有分支
        const treeBranches = await TreeModel.getBranchesByTree(domainId, tree.trid);
        const trunk = treeBranches.find(branch => branch.parentId === null || branch.path.split('/').length === 1);
  
        // 构造递归层级结构
        const buildHierarchy = (parentId: number | null, branches: any[]) => {
            return branches
                .filter(branch => branch.parentId === parentId)
                .map(branch => ({
                    ...branch,
                    subBranches: buildHierarchy(branch.bid, branches)
                }));
        };
  
        const branchHierarchy = {
            trunk: trunk || null,
            branches: trunk ? buildHierarchy(trunk.bid, treeBranches) : [],
        };

        // 转为 D3.js 树图结构
        const toD3TreeNode = (branch: any): any => ({
            name: branch.title,
            docId: branch.docId,
            url: this.url('branch_detail', {
                domainId: domainId,
                trid: tree.trid,
                docId: branch.docId
            }),
            children: (branch.subBranches || []).map(toD3TreeNode)
        });
  
        const d3TreeData = trunk
            ? {
                name: trunk.title,
                docId: trunk.docId,
                url: this.url('branch_detail', {
                    domainId: domainId,
                    trid: tree.trid,
                    docId: trunk.docId
                }),
                children: branchHierarchy.branches.map(toD3TreeNode)
            }
            : null;
  
        // 其他必要数据
        const childrenBranchesCursor = await BranchModel.getBranch(domainId, { parentId: trunk?.bid });
        const childrenBranches = await childrenBranchesCursor.toArray();
  
        const pathLevels = trunk?.path?.split('/').filter(Boolean) || [];
        const pathBranches = await BranchModel.getBranchesByIds(domainId, pathLevels.map(Number));
  
        // 设置响应数据
        this.response.template = 'tree_detail.html';
        this.response.pjax = 'tree_detail.html';
        this.response.body = {
            tree,
            trunk,
            childrenBranches,
            pathBranches,
            treeBranches,
            branchHierarchy,
        };
  
        // 注入给前端用的 D3 结构
        this.UiContext.d3TreeData = d3TreeData;
        this.UiContext.tree = {
            domainId: tree.domainId,
            trid: tree.trid
        };
    }
  
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}

export class TreeBranchHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        try {
            const domainInfo = await domain.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain "${domainId}" not found.`);

            const branches = await BranchModel.getBranch(domainId, { parentId: null });
            if (!branches) throw new Error('No branches found.');

            const ddocs = await branches.toArray();
            const totalCount = ddocs.length;
            const totalPages = Math.ceil(totalCount / pageSize);
            const startIdx = (page - 1) * pageSize;
            const endIdx = startIdx + pageSize;
            const paginatedDocs = ddocs.slice(startIdx, endIdx);

            this.response.template = 'tree_branch.html';
            this.response.body = {
                ddocs: paginatedDocs,
                domainId,
                domainName: domainInfo.name,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error) {
            console.error('Error in TreeDomainHandler.get:', error);
            this.response.template = 'error.html';
            this.response.body = { error: error.message || 'An unexpected error occurred.' };
        }
    }
}

export class BranchDetailHandler extends BranchHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        const ddoc = await BranchModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Branch with docId ${docId} not found.`);
        }

        if (Array.isArray(ddoc.trid)) {
            ddoc.trid = ddoc.trid[0]; 
        }

        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? ddoc : null;
        const udoc = await user.getById(domainId, ddoc.owner);

        const pathLevels = ddoc.path?.split('/').filter(Boolean) || [];
        const pathBranches = await BranchModel.getBranchesByIds(domainId, pathLevels.map(Number));

        const treeBranches = await TreeModel.getBranchesByTree(domainId, ddoc.trid);

        const branchHierarchy = {};
        const trunkBid = pathBranches.length ? pathBranches[0].bid : ddoc.bid;

        const buildHierarchy = (parentId: number, branchList: any[]) => {
            const branches = branchList.filter(branch => branch.parentId === parentId);

            if (branches.length === 0) {
                console.warn(`⚠️ Warning: No branches found for parentId = ${parentId}`);
            } else {
                console.log(`✅ Found branches:`, branches.map(b => ({ bid: b.bid, title: b.title })));
            }

            return branches.map(branch => ({
                ...branch,
                url: this.url('branch_detail', {
                    domainId: domainId,
                    trid: ddoc.trid,
                    docId: branch.docId
                }),
                subBranches: buildHierarchy(branch.bid, branchList)
            }));
        };

        branchHierarchy[ddoc.trid] = buildHierarchy(trunkBid, treeBranches);

        const docs = ddoc.lids?.length
            ? await getDocsByDocId(domainId, ddoc.lids.filter(lid => lid != null).map(Number))
            : [];

        docs.forEach(doc => {
            doc.lid = doc.lid ? String(doc.lid) : String(doc.docId);
        });

        // Removed: repo functionality moved to ejunzrepo plugin
        // const repos: any[] = ddoc.rids ? await getReposByDocId(domainId, ddoc.rids) : [];
        const repos: any[] = [];
        const reposWithFiles = repos.map(repo => ({
            ...repo,
            files: repo.files || [] 
        }));

        const problems = ddoc.lids?.length ? await getProblemsByDocsId(domainId, ddoc.lids[0]) : [];
        const pids = problems.map(p => Number(p.docId));
        const [ctdocs, htdocs, tdocs] = await Promise.all([
            Promise.all(pids.map(pid => getRelated(domainId, pid))),
            Promise.all(pids.map(pid => getRelated(domainId, pid, 'homework'))),
            Promise.resolve([]) // TODO: Implement when TrainingModel is available
        ]);
       
        const resources = {};
        docs.forEach(doc => {
            resources[doc.title] = `/d/system/docs/${doc.docId}`;
        });
        reposWithFiles.forEach(repo => {
            resources[repo.title] = `/d/system/repo/${repo.docId}`;
            (repo.files || []).forEach((file: any) => {
                resources[file.filename] = `/tree/branch/${ddoc.docId}/repo/${repo.rid}/${encodeURIComponent(file.filename)}`;
            });
        });

        const trunk = treeBranches.find(
            branch => branch.parentId === null || branch.path.split('/').length === 1
        );
          
        const toD3TreeNode = (branch: any): any => ({
            name: branch.title,
            docId: branch.docId,
            url: this.url('branch_detail', {
                domainId: domainId,
                trid: ddoc.trid,
                docId: branch.docId
            }),
            children: (branch.subBranches || []).map(toD3TreeNode)
        });
          
        const d3TreeData = trunk
            ? {
                name: trunk.title,
                docId: trunk.docId,
                url: this.url('branch_detail', {
                    domainId: domainId,
                    trid: ddoc.trid,
                    docId: trunk.docId
                }),
                children: buildHierarchy(trunk.bid, treeBranches).map(toD3TreeNode)
            }
            : null;

        this.UiContext.d3TreeData = d3TreeData;
        this.UiContext.tree = {
            domainId,
            trid: ddoc.trid
        };
        this.UiContext.ddoc = ddoc;
          
        this.response.template = 'branch_detail.html';
        this.response.pjax = 'branch_detail.html';
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            docs,
            repos: reposWithFiles, 
            problems,
            pids,
            ctdocs: ctdocs.flat(),
            htdocs: htdocs.flat(),
            tdocs: tdocs.flat(),
            pathBranches,
            treeBranches,
            branchHierarchy,
            resources 
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}

export class TreeCreateTrunkHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId);
        const trid = Number(this.args?.trid);

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            trid
        };
    }

    @param('title', Types.Title)
    @param('trid', Types.String)
    async postCreate(
        domainId: string,
        title: string,
        trid: string,
        lids: number[] = [],
        rids: number[] = []
    ) {
        await this.limitRate('add_trunk', 3600, 60);

        const tridArray = trid.split(',').map(Number).filter(n => !isNaN(n));
        if (tridArray.length === 0) {
            throw new Error(`Invalid trid: ${trid}`);
        }
        const parsedTrid = tridArray[0];

        const bid = await BranchModel.generateNextBid(domainId);

        const docId = await BranchModel.addTrunkNode(
            domainId,
            parsedTrid,
            bid,
            this.user._id,
            title,
            '',
            this.request.ip,
            lids,
            rids
        );

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id, trid: parsedTrid, docId });
    }
}

export class BranchCreateSubbranchHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId);
        const trid = Number(this.args?.trid);

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            trid
        };
    }

    @param('title', Types.Title)
    @param('parentId', Types.Int)
    @param('trid', Types.String)
    async postCreateSubbranch(
        domainId: string,
        title: string,
        parentId: number,
        trid: string,
        lids: number[] = [],  
        rids: number[] = []  
    ) {
        await this.limitRate('add_subbranch', 3600, 60);
        const tridArray = trid.split(',').map(Number).filter(n => !isNaN(n));

        const bid = await BranchModel.generateNextBid(domainId);
        const docId = await BranchModel.addBranchNode(
            domainId,
            tridArray,
            bid,
            parentId,
            this.user._id,
            title,
            '', 
            this.request.ip,
            lids,
            rids
        );

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id,trid, docId });
    }
}

export class BranchEditHandler extends BranchHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        const ddoc = await BranchModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Branch with docId ${docId} not found.`);
        }
        const docs = ddoc.lids?.length
            ? await getDocsByDocId(domainId, ddoc.lids.filter(lid => lid != null).map(Number))
            : [];

        docs.forEach(doc => {
            doc.lid = String(doc.lid || doc.docId);
        });

        // Removed: repo functionality moved to ejunzrepo plugin
        // const repos = ddoc.rids ? await getReposByDocId(domainId, ddoc.rids) : [];
        const repos: any[] = [];
        const problems = ddoc.lids?.length ? await getProblemsByDocsId(domainId, ddoc.lids[0]) : [];
        const pids = problems.map(p => Number(p.docId));
        const [ctdocs, htdocs, tdocs] = await Promise.all([
            Promise.all(pids.map(pid => getRelated(domainId, pid))),
            Promise.all(pids.map(pid => getRelated(domainId, pid, 'homework'))),
            Promise.resolve([]) // TODO: Implement when TrainingModel is available
        ]);

        const resources = {};

        repos.forEach((repo: any) => {
            resources[repo.title] = `/d/${domainId}/repo/${repo.docId}`;
        });

        docs.forEach(doc => {
            resources[doc.title] = `/d/${domainId}/docs/${doc.docId}`;
        });

        problems.forEach(problem => {
            resources[problem.title] = `/p/${domainId}/${problem.docId}`;
        });

        ctdocs.flat().forEach(contest => {
            if (contest && contest.docId && contest.title) {
                resources[contest.title] = `/contest/${domainId}/${contest.docId}`;
            }
        });

        htdocs.flat().forEach(homework => {
            if (homework && homework.docId && homework.title) {
                resources[homework.title] = `/homework/${domainId}/${homework.docId}`;
            }
        });

        tdocs.flat().forEach(training => {
            if (training && training.docId && training.title) {
                resources[training.title] = `/training/${domainId}/${training.docId}`;
            }
        });

        this.response.template = 'branch_edit.html';

        this.response.body = {
            ddoc,
            docs,
            pids,
            ctdocs: ctdocs.flat(),
            htdocs: htdocs.flat(),
            tdocs: tdocs.flat(),
            repos,
            problems,
            trid: this.args.trid,
            resources,
        };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        const branch = await BranchModel.get(domainId, docId);
        if (!branch || !branch.trid) {
            throw new NotFoundError(`Branch with docId ${docId} not found or has no trid.`);
        }

        await BranchModel.edit(domainId, docId, title, content);
 
        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { trid: branch.trid, docId });
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        await BranchModel.deleteNode(domainId, docId);
        this.response.redirect = this.url('tree_detail', { trid: this.ddoc?.trid });
    }
}

export class BranchResourceEditHandler extends BranchHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        const ddoc = await BranchModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Branch with docId ${docId} not found.`);
        }

        this.response.template = 'branch_resource_edit.html';
        this.response.body = {
            ddoc,
            trid: this.args.trid,
            lids: ddoc.lids?.join(',') || '',
            rids: ddoc.rids?.join(',') || '',
        };
    }

    @param('docId', Types.ObjectId)
    @param('lids', Types.String, true)
    @param('rids', Types.String, true)
    async postUpdateResources(domainId: string, docId: ObjectId, lids: string, rids: string) {
        const parsedLids = lids ? lids.split(',').map(Number).filter(n => !isNaN(n)) : [];
        const parsedRids = rids ? rids.split(',').map(Number).filter(n => !isNaN(n)) : [];

        const branch = await BranchModel.get(domainId, docId);
        if (!branch || !branch.trid) {
            throw new NotFoundError(`Branch with docId ${docId} not found or has no trid.`);
        }

        await BranchModel.updateResources(domainId, docId, parsedLids, parsedRids);

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { trid: branch.trid, docId });
    }
}

// Removed: BranchfileDownloadHandler - repo functionality moved to ejunzrepo plugin
// export class BranchfileDownloadHandler extends Handler {
//     async get({ docId, rid, filename }: { docId: string; rid: string|number; filename: string }) {
//         const domainId = this.context.domainId || 'default_domain';
//         const repo = await RepoModel.get(domainId, rid);
//         if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);
//         const actualDocId = repo.docId ?? docId;  
//         const filePath = `repo/${domainId}/${actualDocId}/${filename}`;
//         const fileMeta = await storage.getMeta(filePath);
//         if (!fileMeta) throw new NotFoundError(`File "${filename}" does not exist in repository "${rid}".`);
//         this.response.body = await storage.get(filePath);
//         this.response.type = lookup(filename) || 'application/octet-stream';
//         if (!['application/pdf', 'image/jpeg', 'image/png'].includes(this.response.type)) {
//             this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
//         }
//     }
// }

export async function apply(ctx: Context) {
    ctx.Route('forest_domain', '/forest', ForestDomainHandler);
    ctx.Route('forest_edit', '/forest/:docId/edit', ForestEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('forest_create', '/forest/create', ForestEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_create', '/forest/tree/create', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_detail', '/forest/tree/:trid', TreeDetailHandler);
    ctx.Route('tree_create_trunk', '/forest/tree/:trid/createtrunk', TreeCreateTrunkHandler);
    ctx.Route('tree_edit', '/forest/tree/:trid/edit', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_branch', '/forest/tree/:trid/branch', TreeBranchHandler);
    ctx.Route('branch_create_subbranch', '/forest/tree/:trid/branch/:parentId/createsubbranch', BranchCreateSubbranchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_detail', '/forest/tree/:trid/branch/:docId', BranchDetailHandler);
    ctx.Route('branch_edit', '/forest/tree/:trid/branch/:docId/editbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_resource_edit', '/forest/tree/:trid/branch/:docId/edit/resources', BranchResourceEditHandler, PRIV.PRIV_USER_PROFILE);
    // Removed: branch_file_download route - repo functionality moved to ejunzrepo plugin
    // ctx.Route('branch_file_download', '/forest/tree/:trid/branch/:docId/repo/:rid/:filename', BranchfileDownloadHandler);

    ctx.i18n.load('zh', {
        forest_domain: '森林',
        tree_create: '创建树',
        tree_detail: '树详情',
        tree_edit: '编辑树',
        tree_branch: '树分支',
        branch_create_subbranch: '创建子分支',
        branch_detail: '分支详情',  
        branch_edit: '编辑分支',
        branch_resource_edit: '编辑分支资源',
        branch_file_download: '下载分支文件',
    });
    ctx.i18n.load('en', {
        forest_domain: 'Forest',
        tree_create: 'Create Tree',
        tree_detail: 'Tree Detail',
        tree_edit: 'Edit Tree',
        tree_branch: 'Tree Branch',
        branch_create_subbranch: 'Create Subbranch',
        branch_detail: 'Branch Detail',
        branch_edit: 'Edit Branch',
        branch_resource_edit: 'Edit Branch Resources',
        branch_file_download: 'Download Branch File',
    });
}

