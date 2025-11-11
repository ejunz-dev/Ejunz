import _ from 'lodash';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, Types } from '../service/server';
import { NotFoundError, ForbiddenError } from '../error';
import { PRIV, PERM } from '../model/builtin';
import user from '../model/user';
import domain from '../model/domain';
import system from '../model/system';
import yaml from 'js-yaml';
import { exec as execCb } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import * as document from '../model/document';
import { BaseModel, RepoModel, DocModel, BlockModel, RepoKeywordIndexModel, TYPE_BS, TYPE_RP, TYPE_DC, TYPE_BK } from '../model/repo';
import type { BSDoc, RPDoc, DCDoc, BKDoc } from '../interface';
import * as setting from '../model/setting';
import https from 'https';
import http from 'http';
import McpServerModel, { McpToolModel } from '../model/mcp';

const exec = promisify(execCb);

/**
 * Create default MCP tools for repo (query, create, edit, delete)
 * Skips if tool already exists, safe to call multiple times
 */
export async function createDefaultRepoMcpTools(
    domainId: string,
    serverId: number,
    serverDocId: ObjectId,
    rpid: number,
    owner: number
): Promise<void> {
    const tools = [
        {
            name: `repo_${rpid}_query_doc`,
            description: `Query folders (doc) in repo ${rpid}. Note: doc is a folder/category structure for organizing content, not actual content. Actual content is stored in blocks.`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: 'Folder ID (optional, returns all folders if not provided)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_create_doc`,
            description: `Create folder (doc) in repo ${rpid}. Note: doc is a folder/category structure for organizing content, not actual content. Actual content is stored in blocks.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Folder name' },
                    content: { type: 'string', description: 'Folder description (optional)' },
                    parentId: { type: 'number', description: 'Parent folder ID (optional, creates root folder if not provided)' },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only. Use create_branch first if branch not exists)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['title', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_edit_doc`,
            description: `Edit folder (doc) in repo ${rpid}. Note: doc is a folder/category structure for organizing content, not actual content. Actual content is stored in blocks.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: 'Folder ID' },
                    title: { type: 'string', description: 'Folder name (optional)' },
                    content: { type: 'string', description: 'Folder description (optional)' },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only. Use create_branch first if branch not exists)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['did', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_delete_doc`,
            description: `Delete folder (doc) in repo ${rpid}. Note: doc is a folder/category structure for organizing content.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: 'Folder ID' },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only. Use create_branch first if branch not exists)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['did', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_query_block`,
            description: `Query documents (block) in repo ${rpid}. Note: block is the actual content/document containing specific content data. doc is just a folder/category structure for organizing blocks.`,
            inputSchema: {
                type: 'object',
                properties: {
                    bid: { type: 'number', description: 'Document ID (optional, returns all documents if not provided)' },
                    did: { type: 'number', description: 'Folder ID (optional, filters documents under specific folder)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_create_block`,
            description: `Create document (block) in repo ${rpid}. Note: block is the actual content/document containing specific content data. doc is just a folder/category structure for organizing blocks.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: 'Parent folder ID (doc is folder/category)' },
                    title: { type: 'string', description: 'Document title' },
                    content: { type: 'string', description: 'Document content' },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only. Use create_branch first if branch not exists)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['did', 'title', 'content', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_edit_block`,
            description: `Edit document (block) in repo ${rpid}. Note: block is the actual content/document containing specific content data. doc is just a folder/category structure for organizing blocks.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    bid: { type: 'number', description: 'Document ID' },
                    title: { type: 'string', description: 'Document title (optional)' },
                    content: { type: 'string', description: 'Document content (optional)' },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only. Use create_branch first if branch not exists)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['bid', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_delete_block`,
            description: `Delete document (block) in repo ${rpid}. Note: block is the actual content/document.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    bid: { type: 'number', description: 'Document ID' },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only. Use create_branch first if branch not exists)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['bid', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_query_structure`,
            description: `Query complete structure of repo ${rpid} (including hierarchical relationships of all folders doc and documents block). Returns tree structure for AI to understand repo organization. doc is folder/category, block is actual content/document.`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_update_structure`,
            description: `Update structure of repo ${rpid} (including hierarchical relationships of folders doc and ownership of documents block). Can batch modify parent-child relationships of folders and ownership of documents. doc is folder/category, block is actual content/document.

⚠️ Required workflow (must follow strictly):
1. Step 1: Use repo_${rpid}_create_branch to create a new branch (cannot use main branch)
2. Step 2: Perform create/edit/delete operations on the new branch (this tool)
3. Step 3: Use repo_${rpid}_commit to commit all changes
4. Step 4: Use repo_${rpid}_push to push to remote

❌ Forbidden: Directly modify on main branch (main branch is read-only)
✅ Allowed: Query operations (query/search/ask) on main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    structure: { 
                        type: 'object', 
                        description: 'Structure data containing docs (folders) and blocks (documents) arrays',
                        properties: {
                            docs: {
                                type: 'array',
                                description: 'Folder structure array, each element contains did, parentDid, order, etc.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        did: { type: 'number' },
                                        parentDid: { type: ['number', 'null'] },
                                        order: { type: 'number' },
                                        level: { type: 'number' },
                                    },
                                },
                            },
                            blocks: {
                                type: 'array',
                                description: 'Document structure array, each element contains bid, parentDid, order, etc.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        bid: { type: 'number' },
                                        parentDid: { type: 'number' },
                                        order: { type: 'number' },
                                    },
                                },
                            },
                        },
                    },
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only)' },
                    commitMessage: { type: 'string', description: 'Commit message (optional, AI will auto-add prefix)' },
                },
                required: ['structure', 'branch'],
            },
        },
        {
            name: `repo_${rpid}_query_branches`,
            description: `Query branch information of repo ${rpid} (including status of local and remote branches, commit counts, whether behind/ahead, etc.).`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name to query (optional, queries all branches if not provided)' },
                },
            },
        },
        {
            name: `repo_${rpid}_sync_branch`,
            description: `Sync specified branch of repo ${rpid} with remote branch. If remote has updates (local behind), will auto-pull; if local has unpushed commits (local ahead), will prompt to push.

⚠️ Note:
- This tool first queries remote branch status, if local is behind remote, will auto-execute pull
- If local is ahead of remote, returns prompt message, suggests using push tool
- If local and remote have conflicts, returns error message
- main branch can be queried and synced, but cannot be modified`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                    autoPull: { type: 'boolean', description: 'Auto-pull if local is behind remote (default: true)', default: true },
                },
            },
        },
        {
            name: `repo_${rpid}_pull`,
            description: `Pull updates of repo ${rpid} from remote repository (git pull).`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_push`,
            description: `Push updates of repo ${rpid} to remote repository (git push).`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_search_doc`,
            description: `Search folders (doc) in repo ${rpid}. Uses keyword index to quickly locate folders containing specified keywords. Note: doc is folder/category, not actual content. Actual content is stored in blocks. Supports Chinese and English search.`,
            inputSchema: {
                type: 'object',
                properties: {
                    keywords: { type: 'string', description: 'Search keywords (supports multiple keywords separated by spaces)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                    limit: { type: 'number', description: 'Result limit (default: 50)', default: 50 },
                    skip: { type: 'number', description: 'Skip count for pagination (default: 0)', default: 0 },
                },
                required: ['keywords'],
            },
        },
        {
            name: `repo_${rpid}_search_block`,
            description: `Search documents (block) in repo ${rpid}. Uses keyword index to quickly locate documents containing specified keywords. Note: block is the actual content/document containing specific content data. doc is just a folder/category structure. Supports Chinese and English search.`,
            inputSchema: {
                type: 'object',
                properties: {
                    keywords: { type: 'string', description: 'Search keywords (supports multiple keywords separated by spaces)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                    limit: { type: 'number', description: 'Result limit (default: 50)', default: 50 },
                    skip: { type: 'number', description: 'Skip count for pagination (default: 0)', default: 0 },
                },
                required: ['keywords'],
            },
        },
        {
            name: `repo_${rpid}_ask`,
            description: `Intelligent Q&A in repo ${rpid}. Accepts natural language questions, automatically retrieves relevant content, returns formatted answers (text + links). Similar to DeepWiki Q&A experience.`,
            inputSchema: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'User question (natural language)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                    limit: { type: 'number', description: 'Result limit (default: 10)', default: 10 },
                },
                required: ['question'],
            },
        },
        {
            name: `repo_${rpid}_create_branch`,
            description: `Create new branch for repo ${rpid}. This is the **first step** for Agent to perform any modification operations, must be executed before all modification operations.

📋 Complete workflow (must execute in order):
1. **Step 1 (this tool)**: create_branch - Create new branch (copy data from main branch)
2. **Step 2**: Perform create/edit/delete operations on new branch (create_doc, edit_doc, delete_doc, create_block, edit_block, delete_block, update_structure)
3. **Step 3**: commit - Commit all changes to new branch
4. **Step 4**: push - Push new branch to remote repository

⚠️ Important rules:
- main branch is read-only, can only query, cannot modify
- All modification operations must be performed on non-main branches
- Branch name format suggested: agent-{agentId}-{timestamp} or agent-{agentId}-{purpose}

✅ Example: If user requests "add new document", you should:
1. First call create_branch to create branch (e.g., agent-123-add-doc)
2. Then call create_block on new branch to create document
3. Then call commit to commit
4. Finally call push to push`,
            inputSchema: {
                type: 'object',
                properties: {
                    branchName: { type: 'string', description: 'New branch name (cannot be main, suggested format: agent-{agentId}-{timestamp} or agent-{agentId}-{purpose})' },
                    purpose: { type: 'string', description: 'Operation purpose (userId + userName + userInstruction, for logging)' },
                    userId: { type: 'number', description: 'User ID (optional)' },
                    userName: { type: 'string', description: 'User name (optional)' },
                    userInstruction: { type: 'string', description: 'User instruction (optional)' },
                },
                required: ['branchName', 'purpose'],
            },
        },
        {
            name: `repo_${rpid}_commit`,
            description: `Commit changes of repo ${rpid} to current branch. This is the **third step** of Agent modification operations (after create_branch and all modification operations).

📋 Complete workflow (must execute in order):
1. Step 1: create_branch - Create new branch
2. Step 2: Perform create/edit/delete operations on new branch
3. **Step 3 (this tool)**: commit - Commit all changes
4. Step 4: push - Push to remote

⚠️ Note:
- Must be called after all modification operations are completed
- Commit message will automatically include agent info and operation purpose
- Cannot commit to main branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only)' },
                    message: { type: 'string', description: 'Commit message (optional, will auto-add agent info prefix)' },
                    purpose: { type: 'string', description: 'Operation purpose (userId + userName + userInstruction, for logging)' },
                },
                required: ['branch'],
            },
        },
        {
            name: `repo_${rpid}_push`,
            description: `Push changes of repo ${rpid} to remote repository. This is the **final step** of Agent modification operations (after create_branch, modification operations, commit).

📋 Complete workflow (must execute in order):
1. Step 1: create_branch - Create new branch
2. Step 2: Perform create/edit/delete operations on new branch
3. Step 3: commit - Commit all changes
4. **Step 4 (this tool)**: push - Push to remote

⚠️ Note:
- Will automatically check and commit uncommitted changes before push
- Cannot push to main branch
- After successful push, remote repository will have your new branch`,
            inputSchema: {
                type: 'object',
                properties: {
                    branch: { type: 'string', description: 'Branch name (must be non-main branch, main is read-only)' },
                    purpose: { type: 'string', description: 'Operation purpose (userId + userName + userInstruction, for logging)' },
                },
                required: ['branch'],
            },
        },
    ];

    const existingTools = await McpToolModel.getByServer(domainId, serverId);
    const existingToolNames = new Set(existingTools.map(t => t.name));
    
    for (const tool of tools) {
        if (existingToolNames.has(tool.name)) {
            continue;
        }
        
        try {
            await McpToolModel.add({
                domainId,
                serverId,
                serverDocId,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                owner,
            });
        } catch (err) {
            console.error(`Failed to create MCP tool ${tool.name}:`, err);
        }
    }
}

class DocHandler extends Handler {
    ddoc?: DCDoc;

    @param('docId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: ObjectId) {
        if (docId) {
            const docDoc = await DocModel.get(domainId, docId);
            if (!docDoc) {
                throw new NotFoundError(domainId, docId);
            }
            this.ddoc = docDoc;
        }
    }
}
export class BaseDomainHandler extends Handler {
    async get({ domainId }) {
      domainId = domainId || this.args?.domainId || this.context?.domainId || 'system';
  
      try {
        const base = await BaseModel.getBase(domainId);
        const repos = await RepoModel.getAllRepos(domainId);
  
        const nodes = [
          {
            id: "base-root",
            name: "Base",
            type: "base",
            url: this.url("base_domain", { domainId })
          },
          ...repos.map(repo => ({
            id: `repo-${repo.rpid}`,
            name: repo.title,
            type: 'repo',
            url: this.url('repo_detail', { domainId, rpid: repo.rpid }),
          }))
        ];
  
        const links = repos.map(repo => ({
          source: "base-root",
          target: `repo-${repo.rpid}`
        }));
  
        this.UiContext.forceGraphData = { nodes, links };
  
        this.response.template = 'base_domain.html';
        this.response.body = {
          domainId,
          base: base || null,
          repos: repos || []
        };
  
      } catch (error) {
        console.error("Error fetching base:", error);
        this.response.template = 'error.html';
        this.response.body = { error: "Failed to fetch base" };
      }
    }
  }
  


export class BaseEditHandler extends Handler {
    @param('docId', Types.ObjectId, true) 
    async get(domainId: string, docId?: ObjectId) {
        let base = (await BaseModel.getBase(domainId)) as BSDoc | null; 
        if (!base) {
            base = {
                docType: 30,
                domainId: domainId,
                rpids: [],
                title: '',
                content: '',
                owner: this.user._id,
                createdAt: new Date(),
                updateAt: new Date(),
            } as BSDoc; 
        }

        this.response.template = 'base_edit.html';
        this.response.body = { base };
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postCreate(domainId: string, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        
        const docId = await BaseModel.createBase(domainId, this.user._id, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('base_domain', { domainId });
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        
        await BaseModel.updateBase(domainId, docId, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('base_domain', { domainId });
    }
}




export class RepoEditHandler extends Handler {
    @param('rpid', Types.Int, true)
    async get(domainId: string, rpid: number) {

        
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);

        this.response.template = 'repo_edit.html';
        this.response.body = { repo };
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
    
        
        const { docId, rpid } = await RepoModel.createRepo(domainId, this.user._id, title, content);
        
        try {
            const mcpServerName = `repo-${rpid}-${title}`.substring(0, 50);
            const mcpServer = await McpServerModel.add({
                domainId,
                name: mcpServerName,
                description: `MCP service for repo ${title} (internal)`,
                owner: this.user._id,
                wsToken: null,
                type: 'repo',
            });
            
            await document.set(domainId, TYPE_RP, docId, { mcpServerId: mcpServer.serverId });
            
            await createDefaultRepoMcpTools(domainId, mcpServer.serverId, mcpServer.docId, rpid, this.user._id);
        } catch (err) {
            console.error('Failed to create MCP server for repo:', err);
        }
        
        try {
            await ensureRepoGitRepo(domainId, rpid);
            
            try {
                await createAndPushToGitHubOrg(this, domainId, rpid, title, this.user);
            } catch (err) {
                console.error('Failed to create remote GitHub repo:', err);
            }
        } catch (err) {
            console.error('Failed to create git repo:', err);
        }
    
        this.response.body = { docId, rpid };
        this.response.redirect = this.url('repo_detail', { domainId, rpid }); 
    }
    
    
    

    @param('rpid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, rpid: number, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
    
        if (!title.trim()) {
            throw new Error("Title cannot be empty.");
        }
    
        
        if (!content || typeof content !== 'string') {
            content = '';
        }
    
       await RepoModel.edit(domainId, rpid, title, content);
        this.response.body = { rpid };
        this.response.redirect = this.url('repo_detail', { domainId, rpid });

    }

    @param('rpid', Types.Int)
    async postDelete(domainId: string, rpid: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await RepoModel.deleteRepo(domainId, rpid);
        this.response.body = { rpid };
        this.response.redirect = this.url('base_domain', { domainId });
    }
    
}

export class RepoMcpHandler extends Handler {
    @param('rpid', Types.Int)
    async get(domainId: string, rpid: number) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        
        if (repo.mcpServerId) {
            try {
                const server = await McpServerModel.getByServerId(domainId, repo.mcpServerId);
                if (server) {
                    await createDefaultRepoMcpTools(domainId, repo.mcpServerId, server.docId, rpid, repo.owner);
                }
            } catch (error: any) {
                console.error('Failed to ensure default MCP tools:', error);
            }
        }
        let mcpTools: any[] = [];
        if (repo.mcpServerId) {
            try {
                const tools = await McpToolModel.getByServer(domainId, repo.mcpServerId);
                mcpTools = tools;
            } catch (error: any) {
                console.error('Failed to load MCP tools:', error);
            }
        }
        
        this.response.template = 'repo_mcp.html';
        this.response.body = { repo, mcpTools };
    }

    @param('rpid', Types.Int)
    @param('action', Types.String, true) // create, edit, delete
    @param('toolId', Types.Int, true)
    @param('name', Types.String, true)
    @param('description', Types.String, true)
    @param('operation', Types.String, true) // query, create, edit, delete
    @param('type', Types.String, true) // doc, block
    @param('inputSchema', Types.String, true) // JSON string
    async post(domainId: string, rpid: number, action?: string, toolId?: number, name?: string, description?: string, operation?: string, type?: string, inputSchema?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        if (action === 'delete' && toolId !== undefined) {
            return await this.handleDelete(domainId, rpid, toolId);
        } else if (action === 'edit' && toolId !== undefined) {
            return await this.handleEdit(domainId, rpid, toolId, name, description, inputSchema);
        } else if (action === 'create' && operation && type) {
            return await this.handleCreate(domainId, rpid, name || '', description || '', operation, type);
        } else {
            throw new Error('Invalid action or missing parameters');
        }
    }

    private async handleCreate(domainId: string, rpid: number, name: string, description: string, operation: string, type: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        if (!repo.mcpServerId) {
            throw new Error('MCP server not found for this repo');
        }

        const server = await McpServerModel.getByServerId(domainId, repo.mcpServerId);
        if (!server) {
            throw new Error('MCP server not found');
        }

        let toolName = name;
        if (!toolName || !toolName.trim()) {
            toolName = `repo_${rpid}_${operation}_${type}`;
        }

        let inputSchema: any = {
            type: 'object',
            properties: {},
            required: [],
        };

        if (type === 'doc') {
            if (operation === 'query') {
                inputSchema.properties = {
                    did: { type: 'number', description: 'Document ID (optional, returns all documents if not provided)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
            } else if (operation === 'create') {
                inputSchema.properties = {
                    title: { type: 'string', description: 'Document title' },
                    content: { type: 'string', description: 'Document content' },
                    parentId: { type: 'number', description: 'Parent document ID (optional, creates root document if not provided)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
                inputSchema.required = ['title', 'content'];
            } else if (operation === 'edit') {
                inputSchema.properties = {
                    did: { type: 'number', description: 'Document ID' },
                    title: { type: 'string', description: 'Document title (optional)' },
                    content: { type: 'string', description: 'Document content (optional)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
                inputSchema.required = ['did'];
            } else if (operation === 'delete') {
                inputSchema.properties = {
                    did: { type: 'number', description: 'Document ID' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
                inputSchema.required = ['did'];
            }
        } else if (type === 'block') {
            if (operation === 'query') {
                inputSchema.properties = {
                    bid: { type: 'number', description: 'Block ID (optional, returns all blocks if not provided)' },
                    did: { type: 'number', description: 'Document ID (optional, filters blocks under specific document)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
            } else if (operation === 'create') {
                inputSchema.properties = {
                    did: { type: 'number', description: 'Parent document ID' },
                    title: { type: 'string', description: 'Block title' },
                    content: { type: 'string', description: 'Block content' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
                inputSchema.required = ['did', 'title', 'content'];
            } else if (operation === 'edit') {
                inputSchema.properties = {
                    bid: { type: 'number', description: 'Block ID' },
                    title: { type: 'string', description: 'Block title (optional)' },
                    content: { type: 'string', description: 'Block content (optional)' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
                inputSchema.required = ['bid'];
            } else if (operation === 'delete') {
                inputSchema.properties = {
                    bid: { type: 'number', description: 'Block ID' },
                    branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
                };
                inputSchema.required = ['bid'];
            }
        }

        await McpToolModel.add({
            domainId,
            serverId: repo.mcpServerId,
            serverDocId: server.docId,
            name: toolName,
            description: description || `${operation} ${type} tool for repo ${rpid}`,
            inputSchema,
            owner: this.user._id,
        });

        this.response.redirect = this.url('repo_mcp', { domainId, rpid });
    }

    private async handleEdit(domainId: string, rpid: number, toolId: number, name?: string, description?: string, inputSchema?: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        if (!repo.mcpServerId) {
            throw new Error('MCP server not found for this repo');
        }

        const tool = await McpToolModel.getByToolId(domainId, repo.mcpServerId, toolId);
        if (!tool) {
            throw new NotFoundError(`MCP tool with toolId ${toolId} not found.`);
        }

        const update: any = {};
        if (name !== undefined) update.name = name;
        if (description !== undefined) update.description = description;
        if (inputSchema !== undefined) {
            try {
                update.inputSchema = JSON.parse(inputSchema);
            } catch (e) {
                throw new Error('Invalid inputSchema JSON');
            }
        }

        await McpToolModel.update(domainId, repo.mcpServerId, toolId, update);
        this.response.redirect = this.url('repo_mcp', { domainId, rpid });
    }

    private async handleDelete(domainId: string, rpid: number, toolId: number) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        if (!repo.mcpServerId) {
            throw new Error('MCP server not found for this repo');
        }

        await McpToolModel.del(domainId, repo.mcpServerId, toolId);
        this.response.redirect = this.url('repo_mcp', { domainId, rpid });
    }
}

export class RepoDetailHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, branch?: string) {
      if (!rpid) {
        throw new NotFoundError(`Invalid request: rpid is missing`);
      }
  
      const repo = await RepoModel.getRepoByRpid(domainId, rpid);
      if (!repo) {
        throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
      }
  
      if (!branch || !String(branch).trim()) {
        const target = this.url('repo_detail_branch', { domainId, rpid, branch: 'main' });
        this.response.redirect = target;
        return;
      }
  
      const requestedBranch = branch;
      
      const currentRepoBranch = (repo as any).currentBranch || 'main';
      if (requestedBranch !== currentRepoBranch) {
        await document.set(domainId, TYPE_RP, repo.docId, { currentBranch: requestedBranch });
        (repo as any).currentBranch = requestedBranch;
      }
      
      const repoDocsAll = await RepoModel.getDocsByRepo(domainId, repo.rpid);
      const repoDocs = repoDocsAll.filter(d => (d.branch || 'main') === requestedBranch);
      const rootDocs = repoDocs.filter(doc => doc.parentId === null);
  
      const allDocsWithBlocks = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did, rpid, requestedBranch);
        if (blocks && blocks.length > 0) {
          allDocsWithBlocks[doc.did] = blocks.map(block => ({
            ...block,
            url: this.url('block_detail_branch', {
              domainId,
              rpid: repo.rpid,
              branch: requestedBranch,
              did: doc.did,
              bid: block.bid
            })
          }));
        }
      }

      const buildHierarchy = (parentId: number | null, docs: any[]) => {
        return docs
          .filter(doc => doc.parentId === parentId)
          .map(doc => ({
            ...doc,
            url: this.url('doc_detail_branch', {
              domainId,
              rpid: repo.rpid,
              branch: requestedBranch,
              did: doc.did
            }),
            subDocs: buildHierarchy(doc.did, docs)
          }));
      };
  
      const docHierarchy = {};
      docHierarchy[rpid] = buildHierarchy(null, repoDocs);
  
      let branches: string[] = Array.isArray((repo as any).branches)
        ? ((repo as any).branches as string[])
        : ((typeof (repo as any).branches === 'string' && (repo as any).branches)
            ? [String((repo as any).branches)]
            : []);
      if (!branches.includes('main')) branches.push('main');
      if (!branches.includes(requestedBranch)) branches.push(requestedBranch);
      branches = Array.from(new Set(branches));

      let gitStatus: any = null;
      const githubRepo = (repo.githubRepo || '') as string;
      if (githubRepo && githubRepo.trim()) {
        try {
          let REPO_URL = githubRepo;
          if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
          } else {
            const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
            const systemValue = system.get('ejunzrepo.github_token');
            const GH_TOKEN = settingValue || systemValue || '';
            if (GH_TOKEN) {
              if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                if (!githubRepo.includes('@github.com')) {
                  REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                    .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                } else {
                  REPO_URL = githubRepo;
                }
              } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
              }
            }
          }

          gitStatus = await getGitStatus(domainId, repo.rpid, requestedBranch, REPO_URL);
        } catch (err) {
          console.error('Failed to get git status:', err);
          gitStatus = null;
        }
      } else {
        try {
          gitStatus = await getGitStatus(domainId, repo.rpid, requestedBranch);
        } catch (err) {
          console.error('Failed to get local git status:', err);
          gitStatus = null;
        }
      }
      
      const branchStatus = gitStatus ? {
        behind: gitStatus.behind || 0,
        ahead: gitStatus.ahead || 0,
        hasRemote: gitStatus.hasRemote || false
      } : null;

      const mode = (repo as any).mode || 'file';
      if (mode === 'manuscript') {
        const manuscriptData = await this.buildManuscriptData(domainId, repo.rpid, requestedBranch, repoDocs);
        this.response.template = 'repo_manuscript.html';
        this.response.pjax = 'repo_manuscript.html';
        this.response.body = {
          repo,
          currentBranch: requestedBranch,
          branches,
          branchStatus,
          gitStatus,
          ...manuscriptData,
        };
      } else {
        this.response.template = 'repo_detail.html';
        this.response.pjax = 'repo_detail.html';
      this.response.body = {
        repo,
        rootDocs,
        repoDocs,
        docHierarchy,
        currentBranch: requestedBranch,
        branches,
        branchStatus,
        gitStatus,
      };
      }
  
      this.UiContext.docHierarchy = docHierarchy;
      this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
      this.UiContext.repo = {
        domainId: repo.domainId,
        rpid: repo.rpid,
        currentBranch: requestedBranch,
      };
      this.UiContext.userInfo = {
        domainId: domainId,
        userId: this.user._id,
        userName: this.user.uname || 'unknown',
      };
    }
  
    async post() {
      this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    /**
     * Build document mode data structure
     */
    private async buildManuscriptData(domainId: string, rpid: number, branch: string, repoDocs: DCDoc[]) {
      let docCounter = 0;
      let blockCounter = 0;
      
      const buildTOC = (parentId: number | null, level: number = 0, parentNumber: string = ''): any[] => {
        const children = repoDocs.filter(doc => doc.parentId === parentId);
        return children.map((doc, index) => {
          docCounter++;
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          const docBlocks = repoDocs.filter(d => false);
          
          return {
            type: 'doc',
            did: doc.did,
            number,
            level,
            title: doc.title,
            content: doc.content || '',
            children: buildTOC(doc.did, level + 1, number),
          };
        });
      };

      const buildContent = (parentId: number | null): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => {
            return (a.did || 0) - (b.did || 0);
          });
        
        const result: any[] = [];
        for (const doc of children) {
          result.push({
            type: 'doc',
            did: doc.did,
            title: doc.title,
            content: doc.content || '',
          });
          
          result.push(...buildContent(doc.did));
        }
        return result;
      };

      const allBlocksMap: { [did: number]: BKDoc[] } = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did, rpid, branch);
        if (blocks && blocks.length > 0) {
          allBlocksMap[doc.did] = blocks.sort((a, b) => (a.bid || 0) - (b.bid || 0));
        }
      }

      const buildTOCWithBlocks = (parentId: number | null, level: number = 0, parentNumber: string = ''): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => (a.did || 0) - (b.did || 0));
        
        const tocItems: any[] = [];
        children.forEach((doc, index) => {
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          const blocks = allBlocksMap[doc.did] || [];
          
          const blockItems = blocks.map((block, blockIndex) => ({
            type: 'block',
            did: doc.did,
            bid: block.bid,
            number: `${number}.${String.fromCharCode(97 + blockIndex)}`, // a, b, c...
            level: level + 1,
            title: block.title,
            content: block.content || '',
            preview: (block.content || '').substring(0, 100),
          }));
          
          const subDocs = buildTOCWithBlocks(doc.did, level + 1, number);
          tocItems.push({
            type: 'doc',
            did: doc.did,
            number,
            level,
            title: doc.title,
            content: doc.content || '',
            preview: (doc.content || '').substring(0, 100),
            children: [...blockItems, ...subDocs],
          });
        });
        
        return tocItems;
      };

      const buildContentWithBlocks = (parentId: number | null, parentNumber: string = ''): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => (a.did || 0) - (b.did || 0));
        
        const result: any[] = [];
        children.forEach((doc, index) => {
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          
          result.push({
            type: 'doc',
            did: doc.did,
            number,
            title: doc.title,
            content: doc.content || '',
          });
          
          const blocks = allBlocksMap[doc.did] || [];
          blocks.forEach((block, blockIndex) => {
            result.push({
              type: 'block',
              did: doc.did,
              bid: block.bid,
              number: `${number}.${String.fromCharCode(97 + blockIndex)}`,
              title: block.title,
              content: block.content || '',
            });
          });
          
          result.push(...buildContentWithBlocks(doc.did, number));
        });
        return result;
      };

      const toc = buildTOCWithBlocks(null);
      const content = buildContentWithBlocks(null, '');

      return {
        toc,
        content,
        rawData: {
          docs: repoDocs.map(doc => ({
            did: doc.did,
            title: doc.title,
            content: doc.content || '',
            parentId: doc.parentId,
          })),
          blocks: Object.values(allBlocksMap).flat().map(block => ({
            bid: block.bid,
            did: block.did,
            title: block.title,
            content: block.content || '',
          })),
        },
      };
    }
  }

export class RepoDocHandler extends Handler {
    async get() {
        const domainId = this.args?.domainId || this.context?.domainId || 'system';
        const page = Number(this.args?.page) || 1;
        const pageSize = Number(this.args?.pageSize) || 10;

        try {
            const domainInfo = await domain.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain "${domainId}" not found.`);

            const branches = await DocModel.getDoc(domainId, { parentId: null });
            if (!branches) throw new Error('No branches found.');

            // Simple pagination
            const allDocs = await branches.toArray();
            const totalCount = allDocs.length;
            const totalPages = Math.ceil(totalCount / pageSize);
            const ddocs = allDocs.slice((page - 1) * pageSize, page * pageSize);

            this.response.template = 'repo_doc.html';
            this.response.body = {
                ddocs,
                domainId,
                domainName: domainInfo.name,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error: any) {
            console.error('Error in RepoDocHandler.get:', error);
            this.response.template = 'error.html';
            this.response.body = { error: error.message || 'An unexpected error occurred.' };
        }
        
    }
}


export class DocDetailHandler extends DocHandler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    async get(domainId: string, rpid: number, branch: string | undefined, did: number) {
        if (!rpid || !did) {
            throw new NotFoundError(`Invalid request: rpid or did is missing`);
        }

        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo not found`);
        if (!branch || !String(branch).trim()) {
            this.response.redirect = this.url('doc_detail_branch', { domainId, rpid, branch: repo.currentBranch || 'main', did });
            return;
        }

        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        if (!ddoc) {
            throw new NotFoundError(`Doc with rpid ${rpid} and did ${did} not found.`);
        }
        if (Array.isArray(ddoc.rpid)) {
            ddoc.rpid = ddoc.rpid[0]; 
        }
        const currentBranch = branch || (ddoc as any).branch || 'main';
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? ddoc : null;
        const udoc = await user.getById(domainId, ddoc.owner);

        const repoDocsAll = await RepoModel.getDocsByRepo(domainId, ddoc.rpid);
        const repoDocs = repoDocsAll.filter(doc => (doc.branch || 'main') === currentBranch);

        const allDocsWithBlocks = {};
        for (const doc of repoDocs) {
          const docBlocks = await BlockModel.getByDid(domainId, doc.did, ddoc.rpid, currentBranch);
          if (docBlocks && docBlocks.length > 0) {
            allDocsWithBlocks[doc.did] = docBlocks.map(block => ({
              ...block,
              url: this.url('block_detail_branch', {
                domainId,
                rpid: ddoc.rpid,
                branch: currentBranch,
                did: doc.did,
                bid: block.bid
              })
            }));
          }
        }

        const buildHierarchy = (parentId: number | null, docs: any[]) => {
          return docs
            .filter(doc => doc.parentId === parentId)
            .map(doc => ({
              ...doc,
              url: this.url('doc_detail_branch', {
                domainId,
                rpid: ddoc.rpid,
                branch: currentBranch,
                did: doc.did
              }),
              subDocs: buildHierarchy(doc.did, docs)
            }));
        };
    
        const docHierarchy = {};
        docHierarchy[ddoc.rpid] = buildHierarchy(null, repoDocs);

        const blocks = await BlockModel.getByDid(domainId, ddoc.did, ddoc.rpid, currentBranch);

        this.UiContext.docHierarchy = docHierarchy;
        this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
        this.UiContext.repo = {
          domainId,
          rpid: ddoc.rpid,
          currentBranch,
        };
        this.UiContext.ddoc = ddoc;
          
        this.response.template = 'doc_detail.html';
        this.response.pjax = 'doc_detail.html';
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            blocks,
            repoDocs,
            docHierarchy,
            currentBranch,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}







export class DocCreateHandler extends DocHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId) || null;
        const rpid = Number(this.args?.rpid);
        const branch = (this.args?.branch) || '';
        if (!branch) {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            const b = repo?.currentBranch || 'main';
            this.response.redirect = this.url('doc_create_branch', { domainId, rpid, branch: b });
            return;
        }
        this.response.template = 'doc_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            rpid,
            branch,
        };
    }

    @param('title', Types.Title)
    @param('rpid', Types.String)
    @param('branch', Types.String, true)
    async postCreate(
        domainId: string,
        title: string,
        rpid: string,
        branch?: string,
    ) {
        return this.postCreateSubdoc(domainId, title, rpid, undefined, branch);
    }

    @param('title', Types.Title)
    @param('rpid', Types.String)
    @param('parentId', Types.Int, true)
    @param('branch', Types.String, true)
    async postCreateSubdoc(
        domainId: string,
        title: string,
        rpid: string,
        parentId?: number,
        branch?: string,
    ) {
        await this.limitRate('add_doc', 3600, 60);
        const rpidArray = rpid.split(',').map(Number).filter(n => !isNaN(n));
        if (rpidArray.length === 0) {
            throw new Error(`Invalid rpid: ${rpid}`);
        }
        const parsedRpid = rpidArray[0];
        const repo = await RepoModel.getRepoByRpid(domainId, parsedRpid);
        const effectiveBranch = (branch || repo?.currentBranch || 'main');
        const did = await DocModel.generateNextDid(domainId, parsedRpid, effectiveBranch);
        let docId;
        if (parentId) {
            docId = await DocModel.addSubdocNode(
                domainId,
                [parsedRpid],
                did,
                parentId,
                this.user._id,
                title,
                '',
                this.request.ip,
                effectiveBranch
            );
        } else {
            docId = await DocModel.addRootNode(
                domainId,
                parsedRpid,
                did,
                this.user._id,
                title,
                '',
                this.request.ip,
                effectiveBranch
            );
        }
        this.response.body = { docId, did };
        this.response.redirect = this.url('doc_detail_branch', { uid: this.user._id, rpid: parsedRpid, branch: effectiveBranch, did });
    }

}




// Structure Update Handler
export class RepoStructureUpdateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number) {
        const { structure, creates, deletes, updates, branch, commitMessage } = this.request.body;
        const effectiveBranch = (branch || this.args?.branch || 'main');
        
        if (!structure || !structure.docs) {
            throw new Error('Invalid structure');
        }

        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;

        try {
            if (deletes && Array.isArray(deletes) && deletes.length > 0) {
                await this.deleteItems(domainId, rpid, deletes, effectiveBranch);
            }
            if (creates && creates.length > 0) {
                await this.createItems(domainId, rpid, creates, effectiveBranch);
            }
            if (updates && Array.isArray(updates) && updates.length > 0) {
                await this.updateItems(domainId, rpid, updates, effectiveBranch);
            }
            await this.updateDocStructure(domainId, rpid, structure.docs, effectiveBranch);
            try {
                await commitRepoChanges(domainId, rpid, effectiveBranch, finalCommitMessage, this.user._id, this.user.uname || '');
            } catch (err) {
                console.error('Failed to commit changes:', err);
            }
            
            this.response.body = { success: true, branch: effectiveBranch };
        } catch (error: any) {
            console.error(`Failed to update structure: ${error.message}`);
            throw error;
        }
    }

    async updateItems(domainId: string, rpid: number, updates: any[], branch: string) {
        for (const updateItem of updates) {
            const { type, did, bid, title } = updateItem;
            
            if (type === 'doc' && did && title) {
                const docs = await document.getMulti(domainId, TYPE_DC, { rpid, did, branch }).limit(1).toArray();
                const doc = docs[0] || null;
                if (doc) {
                    await document.set(domainId, TYPE_DC, doc.docId, {
                        title,
                        content: doc.content,
                        branch: branch,
                        updateAt: new Date()
                    });
                }
            } else if (type === 'block' && bid && title) {
                const blocks = await document.getMulti(domainId, TYPE_BK, { rpid, bid, branch }).limit(1).toArray();
                const block = blocks[0] || null;
                if (block) {
                    await document.set(domainId, TYPE_BK, block.docId, {
                        title,
                        content: block.content,
                        branch: branch,
                        updateAt: new Date()
                    });
                }
            }
        }
    }

    async deleteItems(domainId: string, rpid: number, deletes: any[], branch: string) {
        for (const deleteItem of deletes) {
            const { type, did, bid } = deleteItem;
            
            if (type === 'doc' && did) {
                const docs = await document.getMulti(domainId, TYPE_DC, { rpid, did, branch }).limit(1).toArray();
                const doc = docs[0] || null;
                if (doc) {
                    await DocModel.deleteNode(domainId, doc.docId);
                }
            } else if (type === 'block' && bid) {
                const blocks = await document.getMulti(domainId, TYPE_BK, { rpid, bid, branch }).limit(1).toArray();
                const block = blocks[0] || null;
                if (block) {
                    await BlockModel.delete(domainId, block.docId);
                }
            }
        }
    }

    async createItems(domainId: string, rpid: number, creates: any[], branch: string) {
        const placeholderMap: { [key: string]: number } = {};
        const docCreates = creates.filter(c => c.type === 'doc');
        let hasNewDocs = true;
        let round = 0;
        while (hasNewDocs && round < 10) {
            round++;
            hasNewDocs = false;
            for (const create of docCreates) {
                const placeholderId = (create as any).placeholderId;
                if (placeholderId && placeholderMap[placeholderId]) continue;
                const { title, parentDid, parentPlaceholderId } = create;
                if (!title || !title.trim()) continue;
                let actualParentDid: number | null = null;
                let canCreate = false;
                if (parentPlaceholderId) {
                    actualParentDid = placeholderMap[parentPlaceholderId];
                    canCreate = actualParentDid !== undefined;
                } else if (parentDid !== null && parentDid !== undefined) {
                    if (typeof parentDid === 'string') {
                        actualParentDid = placeholderMap[parentDid];
                        canCreate = actualParentDid !== undefined;
                    } else {
                        actualParentDid = parentDid;
                        canCreate = true;
                    }
                } else {
                    canCreate = true;
                }
                if (!canCreate) continue;
                const did = await DocModel.generateNextDid(domainId, rpid, branch);
                const docId = actualParentDid 
                    ? await DocModel.addSubdocNode(
                        domainId,
                        [rpid],
                        did,
                        actualParentDid,
                        this.user._id,
                        title.trim(),
                        '',
                        this.request.ip,
                        branch
                    )
                    : await DocModel.addRootNode(
                        domainId,
                        rpid,
                        did,
                        this.user._id,
                        title.trim(),
                        '',
                        this.request.ip,
                        branch
                    );
                if (placeholderId) {
                    placeholderMap[placeholderId] = did;
                }
                hasNewDocs = true;
            }
        }
        const blockCreates = creates.filter(c => c.type === 'block');
        for (const create of blockCreates) {
            const { title, parentDid, parentPlaceholderId } = create;
            if (!title || !title.trim()) continue;
            let actualParentDid: number | null = null;
            if (parentPlaceholderId) {
                actualParentDid = placeholderMap[parentPlaceholderId];
            } else if (parentDid !== null && parentDid !== undefined) {
                actualParentDid = typeof parentDid === 'string' ? placeholderMap[parentDid] : parentDid;
            }
            if (!actualParentDid) continue;
            await BlockModel.create(
                domainId,
                rpid,
                actualParentDid,
                this.user._id,
                title.trim(),
                '',
                this.request.ip,
                branch
            );
        }
    }

    async updateDocStructure(domainId: string, rpid: number, docs: any[], branch: string, parentDid: number | null = null) {
        for (const docData of docs) {
            const { did, order, subDocs, blocks } = docData;

            const docResults = await document.getMulti(domainId, TYPE_DC, { rpid, did, branch }).limit(1).toArray();
            const doc = docResults[0] || null;
            if (!doc) {
                continue;
            }

            const docIdentifier = (doc as any).docId ?? (doc as any)._id;
            if (!docIdentifier) {
                continue;
            }

            await document.set(domainId, TYPE_DC, docIdentifier, {
                parentId: parentDid,
                order: order || 0,
                branch: branch,
                updateAt: new Date()
            });

            if (blocks && blocks.length > 0) {
                for (const blockData of blocks) {
                    const bid = blockData.bid;
                    const blockOrder = blockData.order;
                    
                    const blockResults = await document.getMulti(domainId, TYPE_BK, { rpid, bid, branch }).limit(1).toArray();
                    const block = blockResults[0] || null;
                    
                    if (block) {
                        
                        const blockIdentifier = (block as any).docId ?? (block as any)._id;
                        if (!blockIdentifier) {
                            continue;
                        }

                        await document.set(domainId, TYPE_BK, blockIdentifier, {
                            did: did,
                            order: blockOrder || 0,
                            branch: branch,
                            updateAt: new Date()
                        });
                    }
                }
            }

            if (subDocs && subDocs.length > 0) {
                await this.updateDocStructure(domainId, rpid, subDocs, branch, did);
            }
        }
    }
}

// Removed: DocCreateSubdocHandler - unified with DocCreateHandler



// Removed: DocEditHandler and DocResourceEditHandler - resource management removed from doc

export class DocEditHandler extends DocHandler {
    @param('docId', Types.ObjectId)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        const ddoc = await DocModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Doc with docId ${docId} not found.`);
        }

        let currentBranch = branch;
        if (!currentBranch) {
            currentBranch = (ddoc as any).branch;
        }
        if (!currentBranch) {
            const repo = await RepoModel.getRepoByRpid(domainId, ddoc.rpid);
            currentBranch = (repo as any)?.currentBranch || 'main';
        }

        this.response.template = 'doc_edit.html';
        this.response.body = {
            ddoc,
            rpid: this.args.rpid,
            currentBranch,
        };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('commitMessage', Types.String, true)
    @param('branch', Types.String, true)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string, commitMessage?: string, branch?: string) {
        const doc = await DocModel.get(domainId, docId);
        if (!doc || !doc.rpid) {
            throw new NotFoundError(`Doc with docId ${docId} not found or has no rpid.`);
        }

        let effectiveBranch = branch;
        if (!effectiveBranch) {
            effectiveBranch = (doc as any).branch;
        }
        if (!effectiveBranch) {
            const repo = await RepoModel.getRepoByRpid(domainId, doc.rpid);
            effectiveBranch = (repo as any)?.currentBranch || 'main';
        }

        const finalBranch = effectiveBranch || 'main';
        await document.set(domainId, TYPE_DC, docId, {
            title,
            content,
            branch: finalBranch,
            updateAt: new Date()
        });
        
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;
        try {
            await commitRepoChanges(domainId, doc.rpid, finalBranch, finalCommitMessage, this.user._id, this.user.uname || '');
        } catch (err) {
            console.error('Failed to commit changes:', err);
        }
 
        this.response.body = { docId, did: doc.did };
        this.response.redirect = this.url('doc_detail_branch', { domainId, rpid: doc.rpid, branch: finalBranch, did: doc.did });
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        await DocModel.deleteNode(domainId, docId);
        this.response.redirect = this.url('repo_detail', { rpid: this.ddoc?.rpid });
    }
}

// Block Handlers
export class BlockCreateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    async get(domainId: string, rpid: number, branch: string | undefined, did: number) {
        if (!branch) {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            const b = repo?.currentBranch || 'main';
            this.response.redirect = this.url('block_create_branch', { domainId, rpid, branch: b, did });
            return;
        }
        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        if (!ddoc) {
            throw new NotFoundError(`Doc not found`);
        }

        this.response.template = 'block_edit.html';
        this.response.body = {
            ddoc,
            rpid: ddoc.rpid,
            did: ddoc.did,
            branch: branch || (ddoc as any).branch || 'main',
        };
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, rpid: number, did: number, title: string, content: string, branch?: string) {
        await this.limitRate('create_block', 3600, 100);
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        const effectiveBranch = branch || repo?.currentBranch || 'main';
        const docId = await BlockModel.create(
            domainId,
            rpid,
            did,
            this.user._id,
            title,
            content,
            this.request.ip,
            effectiveBranch
        );

        const block = await BlockModel.get(domainId, docId);
        this.response.body = { docId, bid: block?.bid };
        this.response.redirect = this.url('block_detail_branch', { rpid, branch: effectiveBranch, did, bid: block?.bid });
    }
}

export class BlockDetailHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async get(domainId: string, rpid: number, branch: string | undefined, did: number, bid: number) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError('Repo not found');
        if (!branch || !String(branch).trim()) {
            this.response.redirect = this.url('block_detail_branch', { domainId, rpid, branch: repo.currentBranch || 'main', did, bid });
            return;
        }
        const currentBranch = branch || 'main';
        const block = await BlockModel.get(domainId, { rpid, bid, branch: currentBranch });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }
        await BlockModel.incrementViews(domainId, block.docId);
        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        const udoc = await user.getById(domainId, block.owner);
        const repoDocs = (await RepoModel.getDocsByRepo(domainId, rpid)).filter(d => (d.branch || 'main') === currentBranch);
        const allDocsWithBlocks = {};
        for (const doc of repoDocs) {
          const docBlocks = await BlockModel.getByDid(domainId, doc.did, rpid, currentBranch);
          if (docBlocks && docBlocks.length > 0) {
            allDocsWithBlocks[doc.did] = docBlocks.map(b => ({
              ...b,
              url: this.url('block_detail_branch', {
                domainId,
                rpid: rpid,
                branch: currentBranch,
                did: doc.did,
                bid: b.bid
              })
            }));
          }
        }
        const buildHierarchy = (parentId: number | null, docs: any[]) => {
          return docs
            .filter(doc => doc.parentId === parentId)
            .map(doc => ({
              ...doc,
              url: this.url('doc_detail_branch', {
                domainId,
                rpid: rpid,
                branch: currentBranch,
                did: doc.did
              }),
              subDocs: buildHierarchy(doc.did, docs)
            }));
        };
        const docHierarchy = {};
        docHierarchy[rpid] = buildHierarchy(null, repoDocs);
        this.UiContext.docHierarchy = docHierarchy;
        this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
        this.UiContext.repo = { domainId, rpid, currentBranch };
        this.UiContext.ddoc = ddoc;
        this.UiContext.block = block;
        this.response.template = 'block_detail.html';
        this.response.pjax = 'block_detail.html';
        this.response.body = { block, ddoc, udoc, currentBranch };
    }
}

export class BlockEditHandler extends Handler {
    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, did: number, bid: number, branch?: string) {
        let currentBranch = branch;
        if (!currentBranch) {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            currentBranch = (repo as any)?.currentBranch || 'main';
        }
        
        const block = await BlockModel.get(domainId, { rpid, bid, branch: currentBranch });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        this.response.template = 'block_edit.html';
        this.response.body = {
            block,
            rpid: block.rpid,
            did: block.did,
            currentBranch,
        };
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('commitMessage', Types.String, true)
    @param('branch', Types.String, true)
    async postUpdate(domainId: string, rpid: number, did: number, bid: number, title: string, content: string, commitMessage?: string, branch?: string) {
        let effectiveBranch = branch;
        if (!effectiveBranch) {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            effectiveBranch = (repo as any)?.currentBranch || 'main';
        }
        
        const block = await BlockModel.get(domainId, { rpid, bid, branch: effectiveBranch });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        const finalBranch = effectiveBranch || 'main';
        
        await document.set(domainId, TYPE_BK, block.docId, {
            title,
            content,
            branch: finalBranch,
            updateAt: new Date()
        });
        
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;
        try {
            await commitRepoChanges(domainId, rpid, finalBranch, finalCommitMessage, this.user._id, this.user.uname || '');
        } catch (err) {
            console.error('Failed to commit changes:', err);
        }

        this.response.body = { bid };
        this.response.redirect = this.url('block_detail_branch', { domainId, rpid, branch: finalBranch, did, bid });
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async postDelete(domainId: string, rpid: number, did: number, bid: number) {
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        await BlockModel.delete(domainId, block.docId);
        
        this.response.redirect = this.url('doc_detail', { rpid, did });
    }
}

/**
 * Check remote branch status, returns number of commits local branch is behind remote
 */
async function checkRemoteBranchStatus(githubRepo: string, branch: string): Promise<{ behind: number; ahead: number; hasRemote: boolean } | null> {
    if (!githubRepo || githubRepo.trim() === '') {
        return null;
    }
    
    let REPO_URL = githubRepo;
    if (!githubRepo.startsWith('git@') && !githubRepo.startsWith('https://') && !githubRepo.startsWith('http://')) {
        return null;
    }
    
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-check-remote-'));
    try {
        try {
            await exec(`git clone --bare ${REPO_URL} .`, { cwd: tmpDir });
        } catch {
            return null;
        }
        
        try {
            await exec(`git ls-remote --heads origin ${branch}`, { cwd: tmpDir });
        } catch {
            return { behind: 0, ahead: 0, hasRemote: false };
        }
        
        const { stdout: remoteCommit } = await exec(`git rev-parse origin/${branch}`, { cwd: tmpDir });
        const remoteCommitHash = remoteCommit.trim();
        
        return { behind: 0, ahead: 0, hasRemote: true };
    } catch (err) {
        return null;
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {}
    }
}

/**
 * Get or create git repository path for repo
 */
function getRepoGitPath(domainId: string, rpid: number): string {
    return path.join('/data/git/ejunz', domainId, String(rpid));
}

/**
 * Initialize or get git repository for repo
 */
export async function ensureRepoGitRepo(domainId: string, rpid: number, remoteUrl?: string): Promise<string> {
    const repoPath = getRepoGitPath(domainId, rpid);
    
    await fs.promises.mkdir(repoPath, { recursive: true });
    let isNewRepo = false;
    try {
        await exec('git rev-parse --git-dir', { cwd: repoPath });
    } catch {
        isNewRepo = true;
        await exec('git init', { cwd: repoPath });
        
        if (remoteUrl) {
            await exec(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
        }
    }
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoPath });
    
    if (!isNewRepo && remoteUrl) {
        try {
            await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath });
        } catch {
            try {
                await exec(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
            } catch {
            }
        }
    }
    
    return repoPath;
}

/**
 * Create repository in organization using GitHub API
 */
async function createGitHubRepo(
    orgName: string,
    repoName: string,
    description: string,
    token: string,
    isPrivate: boolean = false
): Promise<string> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            name: repoName,
            description: description || '',
            private: isPrivate,
            auto_init: false,
        });

        const options = {
            hostname: 'api.github.com',
            port: 443,
            path: `/orgs/${orgName}/repos`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': `token ${token}`,
                'User-Agent': 'ejunz',
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 201) {
                    try {
                        const response = JSON.parse(data);
                        resolve(response.clone_url || response.ssh_url || '');
                    } catch (err) {
                        reject(new Error(`Failed to parse GitHub API response: ${err}`));
                    }
                } else if (res.statusCode === 422) {
                    https.get({
                        hostname: 'api.github.com',
                        port: 443,
                        path: `/repos/${orgName}/${repoName}`,
                        method: 'GET',
                        headers: {
                            'Authorization': `token ${token}`,
                            'User-Agent': 'ejunz',
                        },
                    }, (getRes) => {
                        let getData = '';
                        getRes.on('data', (chunk) => {
                            getData += chunk;
                        });
                        getRes.on('end', () => {
                            if (getRes.statusCode === 200) {
                                try {
                                    const response = JSON.parse(getData);
                                    resolve(response.clone_url || response.ssh_url || '');
                                } catch (err) {
                                    reject(new Error(`Repository already exists but failed to get info: ${err}`));
                                }
                            } else {
                                reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
                            }
                        });
                    }).on('error', reject);
                } else {
                    reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Create repository in GitHub organization and push local content
 */
async function createAndPushToGitHubOrg(
    handler: any,
    domainId: string,
    rpid: number,
    repoTitle: string,
    user: any
): Promise<void> {
    const githubOrg = system.get('ejunzrepo.github_org') || '';
    if (!githubOrg || !githubOrg.trim()) {
        return;
    }
    let orgName = githubOrg.trim();
    if (orgName.startsWith('https://github.com/')) {
        orgName = orgName.replace('https://github.com/', '').replace(/\/$/, '');
    } else if (orgName.startsWith('http://github.com/')) {
        orgName = orgName.replace('http://github.com/', '').replace(/\/$/, '');
    } else if (orgName.startsWith('@')) {
        orgName = orgName.substring(1);
    }
    orgName = orgName.split('/')[0];

    if (!orgName) {
        return;
    }

    const settingValue = handler.ctx.setting.get('ejunzrepo.github_token');
    const systemValue = system.get('ejunzrepo.github_token');
    const GH_TOKEN = settingValue || systemValue || '';
    if (!GH_TOKEN) {
        console.warn('GitHub token not configured, skipping remote repo creation');
        return;
    }

    const repoName = repoTitle
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || `repo-${rpid}`;

    try {
        const remoteUrl = await createGitHubRepo(orgName, repoName, repoTitle, GH_TOKEN, false);
        
        if (!remoteUrl) {
            throw new Error('Failed to get remote repository URL');
        }

        let REPO_URL = remoteUrl;
        if (remoteUrl.startsWith('git@')) {
            REPO_URL = remoteUrl;
        } else if (remoteUrl.startsWith('https://')) {
            if (!remoteUrl.includes('@github.com')) {
                REPO_URL = remoteUrl.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`);
            }
        }

        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (repo) {
            await document.set(domainId, TYPE_RP, repo.docId, {
                githubRepo: REPO_URL,
            });
        }

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-create-'));
        try {
            await buildLocalRepoFromEjunz(domainId, rpid, tmpDir, 'main');
            const commitMessage = `${domainId}/${user._id}/${user.uname || 'unknown'}: Initial commit`;
            await gitInitAndPush(domainId, rpid, tmpDir, REPO_URL, 'main', commitMessage);
        } finally {
            try {
                await fs.promises.rm(tmpDir, { recursive: true, force: true });
            } catch {}
        }
    } catch (err) {
        console.error(`Failed to create and push to GitHub org ${orgName}:`, err);
        throw err;
    }
}

/**
 * Commit changes to git repository (called after save operations)
 */
async function commitRepoChanges(
    domainId: string,
    rpid: number,
    branch: string,
    commitMessage: string,
    userId: number,
    userName: string
): Promise<void> {
    const repoGitPath = getRepoGitPath(domainId, rpid);
    
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        await ensureRepoGitRepo(domainId, rpid);
    }
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoGitPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoGitPath });
    
    try {
        await exec(`git checkout ${branch}`, { cwd: repoGitPath });
    } catch {
        await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
    }
    
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-commit-'));
    try {
        await buildLocalRepoFromEjunz(domainId, rpid, tmpDir, branch);
        
        await copyDir(tmpDir, repoGitPath);
        
        await exec('git add -A', { cwd: repoGitPath });
        
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (stdout.trim()) {
                const finalMessage = commitMessage && commitMessage.trim() 
                    ? commitMessage.trim()
                    : `${domainId}/${userId}/${userName || 'unknown'}`;
                const escapedMessage = finalMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            }
        } catch {
        }
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {}
    }
}

/**
 * Get complete git status information (local and remote)
 */
async function getGitStatus(
    domainId: string,
    rpid: number,
    branch: string,
    remoteUrl?: string
): Promise<{
    hasLocalRepo: boolean;
    hasLocalBranch: boolean;
    hasRemote: boolean;
    hasRemoteBranch: boolean;
    localCommits: number;
    remoteCommits: number;
    behind: number;
    ahead: number;
    uncommittedChanges: boolean;
    currentBranch?: string;
    lastCommit?: string;
    lastCommitMessage?: string;
    lastCommitTime?: string;
} | null> {
    const repoGitPath = getRepoGitPath(domainId, rpid);
    
    const defaultStatus = {
        hasLocalRepo: false,
        hasLocalBranch: false,
        hasRemote: false,
        hasRemoteBranch: false,
        localCommits: 0,
        remoteCommits: 0,
        behind: 0,
        ahead: 0,
        uncommittedChanges: false,
    };
    
    try {
        try {
            await exec('git rev-parse --git-dir', { cwd: repoGitPath });
        } catch {
            return defaultStatus;
        }
        
        const status: any = {
            ...defaultStatus,
            hasLocalRepo: true,
        };
        
        try {
            const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
            status.currentBranch = currentBranch.trim();
        } catch {}
        
        try {
            await exec(`git rev-parse --verify ${branch}`, { cwd: repoGitPath });
            status.hasLocalBranch = true;
            
            try {
                const { stdout: localCount } = await exec(`git rev-list --count ${branch}`, { cwd: repoGitPath });
                status.localCommits = parseInt(localCount.trim()) || 0;
            } catch {}
            
            try {
                const { stdout: lastCommit } = await exec(`git rev-parse ${branch}`, { cwd: repoGitPath });
                const fullCommit = lastCommit.trim();
                status.lastCommit = fullCommit;
                status.lastCommitShort = fullCommit.substring(0, 8);
                
                try {
                    const { stdout: commitMessage } = await exec(`git log -1 --pretty=format:'%s' ${branch}`, { cwd: repoGitPath });
                    const fullMessage = commitMessage.trim();
                    if (fullMessage) {
                        status.lastCommitMessage = fullMessage;
                        status.lastCommitMessageShort = fullMessage.length > 50 ? fullMessage.substring(0, 50) : fullMessage;
                    }
                } catch (err) {
                    try {
                        const { stdout: commitMessage } = await exec(`git log -1 --format=%s ${branch}`, { cwd: repoGitPath });
                        const fullMessage = commitMessage.trim();
                        if (fullMessage) {
                            status.lastCommitMessage = fullMessage;
                            status.lastCommitMessageShort = fullMessage.length > 50 ? fullMessage.substring(0, 50) : fullMessage;
                        }
                    } catch {}
                }
                
                try {
                    const { stdout: commitTime } = await exec(`git log -1 --pretty=format:"%ci" ${branch}`, { cwd: repoGitPath });
                    status.lastCommitTime = commitTime.trim();
                } catch {}
            } catch {}
        } catch {
            status.hasLocalBranch = false;
        }
        
        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            status.uncommittedChanges = statusOutput.trim().length > 0;
        } catch {
            status.uncommittedChanges = false;
        }
        
        if (remoteUrl) {
            try {
                try {
                    await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                } catch {
                    try {
                        await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                    } catch {}
                }
                
                status.hasRemote = true;
                
                try {
                    try {
                        await exec('git fetch origin', { cwd: repoGitPath });
                    } catch {
                        await exec(`git fetch origin ${branch}`, { cwd: repoGitPath });
                    }
                    
                    try {
                        await exec(`git rev-parse --verify origin/${branch}`, { cwd: repoGitPath });
                        status.hasRemoteBranch = true;
                        
                        try {
                            const { stdout: remoteCount } = await exec(`git rev-list --count origin/${branch}`, { cwd: repoGitPath });
                            status.remoteCommits = parseInt(remoteCount.trim()) || 0;
                        } catch {}
                        
                        if (status.hasLocalBranch) {
                            try {
                                const { stdout: aheadOutput } = await exec(`git rev-list --left-right --count origin/${branch}...${branch}`, { cwd: repoGitPath });
                                const parts = aheadOutput.trim().split(/\s+/);
                                if (parts.length >= 2) {
                                    status.behind = parseInt(parts[0].trim()) || 0;
                                    status.ahead = parseInt(parts[1].trim()) || 0;
                                } else {
                                    try {
                                        const { stdout: behindCount } = await exec(`git rev-list --count ${branch}..origin/${branch}`, { cwd: repoGitPath });
                                        status.behind = parseInt(behindCount.trim()) || 0;
                                    } catch {
                                        status.behind = 0;
                                    }
                                    try {
                                        const { stdout: aheadCount } = await exec(`git rev-list --count origin/${branch}..${branch}`, { cwd: repoGitPath });
                                        status.ahead = parseInt(aheadCount.trim()) || 0;
                                    } catch {
                                        status.ahead = 0;
                                    }
                                }
                            } catch (err) {
                                try {
                                    await exec(`git merge-base ${branch} origin/${branch}`, { cwd: repoGitPath });
                                    try {
                                        const { stdout: behindCount } = await exec(`git rev-list --count ${branch}..origin/${branch}`, { cwd: repoGitPath });
                                        status.behind = parseInt(behindCount.trim()) || 0;
                                    } catch {
                                        status.behind = 0;
                                    }
                                    try {
                                        const { stdout: aheadCount } = await exec(`git rev-list --count origin/${branch}..${branch}`, { cwd: repoGitPath });
                                        status.ahead = parseInt(aheadCount.trim()) || 0;
                                    } catch {
                                        status.ahead = 0;
                                    }
                                } catch {
                                    if (status.localCommits > 0 && status.remoteCommits > 0) {
                                        status.ahead = Math.max(0, status.localCommits - status.remoteCommits);
                                    } else {
                                        status.ahead = 0;
                                    }
                                    status.behind = 0;
                                }
                            }
                        }
                    } catch {
                        status.hasRemoteBranch = false;
                    }
                } catch {
                    status.hasRemoteBranch = false;
                }
            } catch {
                status.hasRemote = false;
            }
        }
        
        return status;
    } catch (err) {
        console.error('Failed to get git status:', err);
        return defaultStatus;
    }
}

/**
 * Check difference between local and remote branches (requires local git repository)
 */
async function checkLocalBranchStatus(repoDir: string, branch: string, remoteUrl: string): Promise<{ behind: number; ahead: number; hasRemote: boolean } | null> {
    try {
        try {
            await exec('git rev-parse --git-dir', { cwd: repoDir });
        } catch {
            return null;
        }
        
        try {
            await exec('git remote get-url origin', { cwd: repoDir });
        } catch {
            await exec(`git remote add origin ${remoteUrl}`, { cwd: repoDir });
        }
        
        try {
            await exec(`git fetch origin ${branch}`, { cwd: repoDir });
        } catch {
            return { behind: 0, ahead: 0, hasRemote: false };
        }
        
        try {
            await exec(`git rev-parse --verify ${branch}`, { cwd: repoDir });
        } catch {
            return { behind: 0, ahead: 0, hasRemote: true };
        }
        
        try {
            const { stdout: behindCount } = await exec(`git rev-list --count ${branch}..origin/${branch}`, { cwd: repoDir });
            const { stdout: aheadCount } = await exec(`git rev-list --count origin/${branch}..${branch}`, { cwd: repoDir });
            
            return {
                behind: parseInt(behindCount.trim()) || 0,
                ahead: parseInt(aheadCount.trim()) || 0,
                hasRemote: true
            };
        } catch {
            return { behind: 0, ahead: 0, hasRemote: true };
        }
    } catch {
        return null;
    }
}

async function buildLocalRepoFromEjunz(domainId: string, rpid: number, targetDir: string, branch: string = 'main') {
    const repo = await RepoModel.getRepoByRpid(domainId, rpid);
    if (!repo) throw new Error(`Repo not found: rpid=${rpid}`);
    const docsAll = await RepoModel.getDocsByRepo(domainId, rpid);
    const docs = docsAll.filter(d => (d.branch || 'main') === branch);

    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';

    const childrenMap = new Map<number|null, DCDoc[]>();
    for (const d of docs) {
        const key = (d.parentId ?? null) as number|null;
        if (!childrenMap.has(key)) childrenMap.set(key, []);
        childrenMap.get(key)!.push(d);
    }

    const docOrderValue = (doc: DCDoc) => doc.order ?? doc.did ?? 0;
    const blockOrderValue = (block: BKDoc) => block.order ?? block.bid ?? 0;

    const sortDocs = (list: DCDoc[]) =>
        list
            .slice()
            .sort((a, b) => {
                const orderA = docOrderValue(a);
                const orderB = docOrderValue(b);
                if (orderA !== orderB) return orderA - orderB;
                return (a.did || 0) - (b.did || 0);
            });

    const sortBlocks = (list: BKDoc[]) =>
        list
            .slice()
            .sort((a, b) => {
                const orderA = blockOrderValue(a);
                const orderB = blockOrderValue(b);
                if (orderA !== orderB) return orderA - orderB;
                return (a.bid || 0) - (b.bid || 0);
            });

    async function writeDocTree(parentId: number|null, parentPath: string) {
        const list = sortDocs(childrenMap.get(parentId) || []);
        for (const d of list) {
            const dirName = sanitize(d.title);
            const curDir = path.join(parentPath, dirName);
            await fs.promises.mkdir(curDir, { recursive: true });

            if (d.content && d.content.trim()) {
                const readmePath = path.join(curDir, 'README.md');
                await fs.promises.writeFile(readmePath, d.content, 'utf8');
            }

            const blocksRaw = await BlockModel.getByDid(domainId, d.did, rpid, branch);
            const blocks = sortBlocks(blocksRaw || []);
            for (const b of blocks) {
                const fileName = `${sanitize(b.title)}.md`;
                const filePath = path.join(curDir, fileName);
                await fs.promises.writeFile(filePath, b.content ?? '', 'utf8');
            }

            const children = childrenMap.get(d.did) || [];
            if (blocks.length === 0 && children.length === 0) {
                const keepPath = path.join(curDir, '.keep');
                await fs.promises.writeFile(keepPath, '', 'utf8');
            }

            await writeDocTree(d.did, curDir);
        }
    }

    await writeDocTree(null, targetDir);

    await fs.promises.writeFile(
        path.join(targetDir, 'README.md'),
        repo.content || `# ${repo.title}\n\nThis repo is generated by ejunzrepo.`,
        'utf8'
    );
}

/**
 * Copy source directory contents to target directory (overwrite), excluding .git directory
 */
async function copyDir(src: string, dest: string) {
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await fs.promises.mkdir(destPath, { recursive: true });
            await copyDir(srcPath, destPath);
        } else {
            await fs.promises.copyFile(srcPath, destPath);
        }
    }
}

/**
 * Git version control push: using actual git repository
 */
async function gitInitAndPush(
    domainId: string,
    rpid: number,
    sourceDir: string, 
    remoteUrlWithAuth: string, 
    branch: string = 'main', 
    commitMessage: string = 'chore: sync from ejunzrepo'
) {
    const repoGitPath = await ensureRepoGitRepo(domainId, rpid, remoteUrlWithAuth);
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoGitPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoGitPath });
    
    let isNewRepo = false;
    
    try {
        try {
            await exec('git rev-parse HEAD', { cwd: repoGitPath });
            isNewRepo = false;
        } catch {
            isNewRepo = true;
        }
        
        if (isNewRepo) {
            try {
                const tmpCloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-clone-'));
                try {
                    await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmpCloneDir });
                    await fs.promises.cp(path.join(tmpCloneDir, '.git'), path.join(repoGitPath, '.git'), { recursive: true });
                    isNewRepo = false;
                } catch {
                } finally {
                    try {
                        await fs.promises.rm(tmpCloneDir, { recursive: true, force: true });
                    } catch {}
                }
            } catch {}
        } else {
            try {
                await exec('git fetch origin', { cwd: repoGitPath });
            } catch {}
        }
        
        try {
            await exec(`git checkout ${branch}`, { cwd: repoGitPath });
        } catch {
            try {
                await exec(`git checkout -b ${branch} origin/${branch}`, { cwd: repoGitPath });
            } catch {
                try {
                    const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                    const baseBranch = currentBranch.trim() || 'main';
                    await exec(`git checkout -b ${branch} ${baseBranch}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                }
            }
        }
        
        if (!isNewRepo) {
            try {
                await exec(`git pull origin ${branch}`, { cwd: repoGitPath });
            } catch {
            }
        }
        
        if (!isNewRepo) {
            try {
                const { stdout: trackedFiles } = await exec('git ls-files', { cwd: repoGitPath });
                const files = trackedFiles.trim().split('\n').filter(f => f && !f.startsWith('.git/'));
                for (const file of files) {
                    const filePath = path.join(repoGitPath, file);
                    try {
                        await fs.promises.unlink(filePath);
                    } catch {
                    }
                }
                const deleteEmptyDirs = async (dir: string) => {
                    try {
                        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.name === '.git') continue;
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                await deleteEmptyDirs(fullPath);
                                try {
                                    await fs.promises.rmdir(fullPath);
                                } catch {
                                }
                            }
                        }
                    } catch {
                    }
                };
                await deleteEmptyDirs(repoGitPath);
            } catch {
            }
        }
        
        await copyDir(sourceDir, repoGitPath);
        
        await exec('git add -A', { cwd: repoGitPath });
        
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (stdout.trim()) {
                const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            }
        } catch (err) {
            const escapedMessage = commitMessage.replace(/'/g, "'\\''");
            try {
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            } catch {
            }
        }
        
        if (isNewRepo) {
            await exec(`git push -u origin ${branch}`, { cwd: repoGitPath });
        } else {
            try {
                await exec(`git push origin ${branch}`, { cwd: repoGitPath });
            } catch {
                await exec(`git push -u origin ${branch}`, { cwd: repoGitPath });
            }
        }
    } catch (err) {
        throw err;
    }
}

async function cloneRepoToTemp(remoteUrlWithAuth: string): Promise<string> {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-gh-'));
    await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmp });
    return tmp;
}

async function importGitStructureToEjunz(domainId: string, rpid: number, localDir: string, userId: number, ip: string, branch: string = 'main') {
    const exists = await fs.promises
        .stat(localDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
    if (!exists) return;

    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim();

    const repoReadmePath = path.join(localDir, 'README.md');
    try {
        const repoContent = await fs.promises.readFile(repoReadmePath, 'utf8');
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (repo) {
            await document.set(domainId, TYPE_RP, repo.docId, {
                content: repoContent
            });
        }
    } catch (err) {
    }

    async function ensureDoc(parentDid: number|null, dirPath: string, dirName: string): Promise<number> {
        const title = sanitize(dirName) || 'untitled';
        let did: number;
        
        const docReadmePath = path.join(dirPath, 'README.md');
        let docContent = '';
        try {
            docContent = await fs.promises.readFile(docReadmePath, 'utf8');
        } catch (err) {
        }
        
        if (parentDid == null) {
            const newDid = await DocModel.generateNextDid(domainId, rpid, branch);
            const docId = await DocModel.addRootNode(domainId, rpid, newDid, userId, title, docContent, ip, branch);
            did = newDid;
        } else {
            const newDid = await DocModel.generateNextDid(domainId, rpid, branch);
            const docId = await DocModel.addSubdocNode(domainId, [rpid], newDid, parentDid, userId, title, docContent, ip, branch);
            did = newDid;
        }
        return did;
    }

    async function walk(parentDid: number|null, currentDir: string) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
                if (parentDid == null) continue;
                const content = await fs.promises.readFile(path.join(currentDir, e.name), 'utf8');
                const nameWithout = e.name.replace(/\.md$/i, '');
                const title = sanitize(nameWithout) || 'untitled';
                await BlockModel.create(domainId, rpid, parentDid, userId, title, content, ip, branch);
            }
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                const childDirPath = path.join(currentDir, e.name);
                const childDid = await ensureDoc(parentDid, childDirPath, e.name);
                await walk(childDid, childDirPath);
            }
        }
    }

    const top = await fs.promises.readdir(localDir, { withFileTypes: true });
    for (const d of top) {
        if (d.isDirectory() && d.name !== '.git') {
            const did = await ensureDoc(null, path.join(localDir, d.name), d.name);
            await walk(did, path.join(localDir, d.name));
        }
    }
}

async function cloneBranchData(domainId: string, rpid: number, sourceBranch: string, targetBranch: string, userId: number, ip: string) {
    if (sourceBranch === targetBranch) return;
    
    const allDocs = await RepoModel.getDocsByRepo(domainId, rpid);
    const sourceDocs = allDocs.filter(d => (d.branch || 'main') === sourceBranch);
    if (sourceDocs.length === 0) return;

    const didMap = new Map<number, number>();

    const getDepth = (doc: DCDoc, allDocs: DCDoc[]): number => {
        if (doc.parentId == null) return 0;
        const parent = allDocs.find(d => d.did === doc.parentId);
        if (!parent) return 0;
        return 1 + getDepth(parent, allDocs);
    };

    const sortedDocs = sourceDocs.slice().sort((a, b) => {
        const depthA = getDepth(a, sourceDocs);
        const depthB = getDepth(b, sourceDocs);
        if (depthA !== depthB) return depthA - depthB;
        const orderA = a.order ?? a.did ?? 0;
        const orderB = b.order ?? b.did ?? 0;
        if (orderA !== orderB) return orderA - orderB;
        return (a.did || 0) - (b.did || 0);
    });

    for (const d of sortedDocs) {
        const isRoot = d.parentId == null;
        if (isRoot) {
            const newDid = await DocModel.generateNextDid(domainId, rpid, targetBranch);
            await DocModel.addRootNode(domainId, rpid, newDid, d.owner || userId, d.title, d.content || '', ip, targetBranch);
            didMap.set(d.did, newDid);
        } else {
            const parentNewDid = didMap.get(d.parentId!);
            if (parentNewDid == null) {
                console.error(`Parent document ${d.parentId} not found in didMap for doc ${d.did}`);
                continue;
            }
            const newDid = await DocModel.generateNextDid(domainId, rpid, targetBranch);
            await DocModel.addSubdocNode(domainId, [rpid], newDid, parentNewDid, d.owner || userId, d.title, d.content || '', ip, targetBranch);
            didMap.set(d.did, newDid);
        }

        const blocks = await BlockModel.getByDid(domainId, d.did, rpid, sourceBranch);
        const newDid = didMap.get(d.did)!;
        for (const b of blocks) {
            await BlockModel.create(domainId, rpid, newDid, b.owner || userId, b.title, b.content || '', ip, targetBranch);
        }
    }
}
/**
 * Clear local data for specified repo+branch (docs and blocks)
 */
async function clearRepoBranchData(domainId: string, rpid: number, branch: string) {
    const blocks = await document.getMulti(domainId, TYPE_BK, { rpid, branch }).toArray();
    for (const b of blocks) {
        await document.deleteOne(domainId, TYPE_BK, b.docId);
    }
    const docs = await document.getMulti(domainId, TYPE_DC, { rpid, branch }).toArray();
    for (const d of docs) {
        await document.deleteOne(domainId, TYPE_DC, d.docId);
    }
}
// (deprecated old RepoGithubPushHandler removed)


export class RepoGithubPushHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        
        const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
        const systemValue = system.get('ejunzrepo.github_token');
        const GH_TOKEN = settingValue || systemValue || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        
        const githubRepo = (repo.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in repo settings.');
        }
        
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
        } else {
            if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                if (githubRepo.includes('@github.com')) {
                    REPO_URL = githubRepo;
                } else {
                    REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                        .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        const repoGitPath = await ensureRepoGitRepo(domainId, rpid, REPO_URL);
        
        const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
        const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
        await exec(`git config user.name "${botName}"`, { cwd: repoGitPath });
        await exec(`git config user.email "${botEmail}"`, { cwd: repoGitPath });
        
        try {
            try {
                await exec(`git checkout ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                await exec(`git checkout -b ${effectiveBranch}`, { cwd: repoGitPath });
            }
            
            try {
                await exec(`git remote set-url origin ${REPO_URL}`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec(`git remote add origin ${REPO_URL}`, { cwd: repoGitPath });
                } catch {}
            }
            
            try {
                await exec('git fetch origin', { cwd: repoGitPath });
            } catch {}
            
            try {
                const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
                const hasUncommittedChanges = statusOutput.trim().length > 0;
                if (hasUncommittedChanges) {
                    await exec('git add -A', { cwd: repoGitPath });
                    const defaultMessage = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
                    const escapedMessage = defaultMessage.replace(/'/g, "'\\''");
                    await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
                }
                
                try {
                    await exec(`git rev-parse --verify origin/${effectiveBranch}`, { cwd: repoGitPath });
                    const { stdout: aheadCount } = await exec(`git rev-list --count origin/${effectiveBranch}..${effectiveBranch}`, { cwd: repoGitPath });
                    const ahead = parseInt(aheadCount.trim()) || 0;
                    
                    if (ahead > 0) {
                        await exec(`git push origin ${effectiveBranch}`, { cwd: repoGitPath });
                    } else {
                        try {
                            await exec(`git push -u origin ${effectiveBranch}`, { cwd: repoGitPath });
                        } catch {
                        }
                    }
                } catch {
                    await exec(`git push -u origin ${effectiveBranch}`, { cwd: repoGitPath });
                }
            } catch (err) {
                try {
                    await exec(`git push -u origin ${effectiveBranch}`, { cwd: repoGitPath });
                } catch (pushErr) {
                    throw new Error(`Failed to push: ${pushErr}`);
                }
            }
            
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Push failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: effectiveBranch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, branch?: string) {
        return this.post(domainId, rpid, branch);
    }
}

export class RepoGithubPullHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        const githubRepo = (repo.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in repo settings.');
        }
        
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
        } else {
            const GH_TOKEN = this.ctx.setting.get('ejunzrepo.github_token') || '';
            if (!GH_TOKEN) {
                throw new Error('GitHub token not configured. Please configure it in system settings.');
            }
            
            if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                if (githubRepo.includes('@github.com')) {
                    REPO_URL = githubRepo;
                } else {
                    REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                        .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        const repoGitPath = await ensureRepoGitRepo(domainId, rpid, REPO_URL);
        
        try {
            try {
                await exec(`git fetch origin ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                throw new Error(`Failed to fetch remote branch ${effectiveBranch}`);
            }
            
            try {
                await exec(`git rev-parse --verify ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                await exec(`git checkout -b ${effectiveBranch} origin/${effectiveBranch}`, { cwd: repoGitPath });
            }
            
            await exec(`git checkout ${effectiveBranch}`, { cwd: repoGitPath });
            await exec(`git reset --hard origin/${effectiveBranch}`, { cwd: repoGitPath });
            await clearRepoBranchData(domainId, rpid, effectiveBranch);
            await importGitStructureToEjunz(domainId, rpid, repoGitPath, this.user._id, this.request.ip, effectiveBranch);
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Pull failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: effectiveBranch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, branch?: string) {
        return this.post(domainId, rpid, branch);
    }
}

export class RepoBranchCreateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async post(domainId: string, rpid: number, branch: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        
        const currentBranch = (repo as any).currentBranch || 'main';
        if (currentBranch !== 'main') {
            throw new ForbiddenError('Branches can only be created from the main branch.');
        }
        
        const branches = Array.isArray(repo.branches) ? repo.branches.slice() : [];
        const newBranch = (branch || '').trim() || 'main';
        if (!branches.includes(newBranch)) branches.push(newBranch);
        await document.set(domainId, TYPE_RP, repo.docId, { branches, currentBranch: newBranch });

        try {
            await clearRepoBranchData(domainId, rpid, newBranch);
        } catch (e) {
            console.error('clearRepoBranchData failed:', e);
        }

        try {
            const repoGitPath = await ensureRepoGitRepo(domainId, rpid);
            
            try {
                await exec(`git checkout main`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec(`git checkout -b main`, { cwd: repoGitPath });
                } catch {
                    const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                    if (currentBranch.trim() !== 'main') {
                        await exec(`git checkout -b main`, { cwd: repoGitPath });
                    }
                }
            }
            const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-sync-main-'));
            try {
                await buildLocalRepoFromEjunz(domainId, rpid, tmpDir, 'main');
                await copyDir(tmpDir, repoGitPath);
            } finally {
                try {
                    await fs.promises.rm(tmpDir, { recursive: true, force: true });
                } catch {}
            }
        } catch (err) {
            console.error('Failed to sync main branch to Git:', err);
        }

        try {
            const repoGitPath = await ensureRepoGitRepo(domainId, rpid);
            
            let branchExists = false;
            try {
                await exec(`git rev-parse --verify ${newBranch}`, { cwd: repoGitPath });
                branchExists = true;
            } catch {
                branchExists = false;
            }
            
            if (!branchExists) {
                await exec(`git checkout main`, { cwd: repoGitPath });
                await exec(`git checkout -b ${newBranch}`, { cwd: repoGitPath });
            } else {
                await exec(`git checkout ${newBranch}`, { cwd: repoGitPath });
            }
        } catch (err) {
            console.error('Failed to create git branch:', err);
        }

        try {
            await cloneBranchData(domainId, rpid, 'main', newBranch, this.user._id, this.request.ip);
        } catch (e) {
            console.error('cloneBranchData failed:', e);
        }

        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: newBranch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async get(domainId: string, rpid: number, branch: string) { return this.post(domainId, rpid, branch); }
}

export class RepoBranchSwitchHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async post(domainId: string, rpid: number, branch: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        await document.set(domainId, TYPE_RP, repo.docId, { currentBranch: branch });
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async get(domainId: string, rpid: number, branch: string) { return this.post(domainId, rpid, branch); }
}

export class RepoModeSwitchHandler extends Handler {
    @param('rpid', Types.Int)
    @param('mode', Types.String)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, mode: string, branch?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        
        const validMode = (mode === 'file' || mode === 'manuscript') ? mode : 'file';
        await document.set(domainId, TYPE_RP, repo.docId, { mode: validMode });
        
        const targetBranch = branch || repo.currentBranch || 'main';
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: targetBranch });
    }

    @param('rpid', Types.Int)
    @param('mode', Types.String)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, mode: string, branch?: string) {
        return this.post(domainId, rpid, mode, branch);
    }
}

export class RepoManuscriptBatchUpdateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        
        const effectiveBranch = branch || repo.currentBranch || 'main';
        const { updates, creates, deletes, commitMessage } = this.request.body;
        
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;
        
        try {
            if (deletes && Array.isArray(deletes) && deletes.length > 0) {
                for (const deleteItem of deletes) {
                    const { type, did, bid } = deleteItem;
                    
                    if (type === 'doc' && did) {
                        const doc = await DocModel.get(domainId, { rpid, did });
                        if (doc && (doc.branch || 'main') === effectiveBranch) {
                            await DocModel.deleteNode(domainId, doc.docId);
                        }
                    } else if (type === 'block' && bid) {
                        const block = await BlockModel.get(domainId, { rpid, bid });
                        if (block && (block.branch || 'main') === effectiveBranch) {
                            await BlockModel.delete(domainId, block.docId);
                        }
                    }
                }
            }
            
            if (updates && Array.isArray(updates)) {
                for (const update of updates) {
                    const { type, did, bid, title, content } = update;
                    
                    if (type === 'doc' && did) {
                        const doc = await DocModel.get(domainId, { rpid, did });
                        if (doc && (doc.branch || 'main') === effectiveBranch) {
                            await DocModel.edit(domainId, doc.docId, title || doc.title, content !== undefined ? content : doc.content);
                        }
                    } else if (type === 'block' && bid) {
                        const block = await BlockModel.get(domainId, { rpid, bid });
                        if (block && (block.branch || 'main') === effectiveBranch) {
                            await BlockModel.edit(domainId, block.docId, title || block.title, content !== undefined ? content : block.content);
                        }
                    }
                }
            }
            
            if (creates && Array.isArray(creates)) {
                for (const create of creates) {
                    const { type, parentDid, title, content, position } = create;
                    
                    if (type === 'doc') {
                        const did = await DocModel.generateNextDid(domainId, rpid, effectiveBranch);
                        if (parentDid) {
                            await DocModel.addSubdocNode(
                                domainId,
                                [rpid],
                                did,
                                parentDid,
                                this.user._id,
                                title || 'Untitled',
                                content || '',
                                this.request.ip,
                                effectiveBranch
                            );
                        } else {
                            await DocModel.addRootNode(
                                domainId,
                                rpid,
                                did,
                                this.user._id,
                                title || 'Untitled',
                                content || '',
                                this.request.ip,
                                effectiveBranch
                            );
                        }
                    } else if (type === 'block' && parentDid) {
                        await BlockModel.create(
                            domainId,
                            rpid,
                            parentDid,
                            this.user._id,
                            title || 'Untitled',
                            content || '',
                            this.request.ip,
                            effectiveBranch
                        );
                    }
                }
            }
            
            const structure = this.request.body?.structure;
            if (structure) {
                await this.applyStructureUpdates(domainId, rpid, effectiveBranch, structure);
            }
            
            try {
                await commitRepoChanges(domainId, rpid, effectiveBranch, finalCommitMessage, this.user._id, this.user.uname || '');
            } catch (err) {
                console.error('Failed to commit changes:', err);
            }
            
            this.response.body = { success: true, branch: effectiveBranch };
        } catch (error: any) {
            console.error(`Failed to batch update manuscript: ${error.message}`);
            this.response.status = 500;
            this.response.body = { success: false, error: error.message };
        }
    }

    private async applyStructureUpdates(domainId: string, rpid: number, branch: string, structure: any) {
        const docEntries = Array.isArray(structure?.docs) ? structure.docs : [];
        const blockEntries = Array.isArray(structure?.blocks) ? structure.blocks : [];

        const docCache = new Map<number, string>();

        const sortedDocs = docEntries
            .filter((entry: any) => entry && typeof entry.did === 'number')
            .sort((a: any, b: any) => {
                const levelA = typeof a.level === 'number' ? a.level : Number(a.level) || 0;
                const levelB = typeof b.level === 'number' ? b.level : Number(b.level) || 0;
                if (levelA !== levelB) return levelA - levelB;
                const orderA = typeof a.order === 'number' ? a.order : Number(a.order) || 0;
                const orderB = typeof b.order === 'number' ? b.order : Number(b.order) || 0;
                if (orderA !== orderB) return orderA - orderB;
                return a.did - b.did;
            });

        for (const entry of sortedDocs) {
            const did = entry.did as number;
            const doc = await DocModel.get(domainId, { rpid, did } as any);
            if (!doc || (doc.branch || 'main') !== branch) continue;

            const parentDidValue = typeof entry.parentDid === 'number'
                ? entry.parentDid
                : (entry.parentDid === null ? null : undefined);

            let parentPath = '';
            if (typeof parentDidValue === 'number') {
                if (docCache.has(parentDidValue)) {
                    parentPath = docCache.get(parentDidValue)!;
                } else {
                    const parentDoc = await DocModel.get(domainId, { rpid, did: parentDidValue } as any);
                    if (parentDoc && (parentDoc.branch || 'main') === branch) {
                        parentPath = parentDoc.path || '';
                        docCache.set(parentDidValue, parentPath);
                    } else {
                        parentPath = '';
                    }
                }
            }

            const newPath = parentPath ? `${parentPath}/${did}` : `/${did}`;
            const updatePayload: any = {
                parentId: typeof parentDidValue === 'number' ? parentDidValue : null,
                order: typeof entry.order === 'number' ? entry.order : Number(entry.order) || 0,
                path: newPath,
            };

            await document.set(domainId, TYPE_DC, doc.docId, updatePayload);
            docCache.set(did, newPath);
        }

        for (const entry of blockEntries) {
            if (!entry || typeof entry.bid !== 'number') continue;
            const block = await BlockModel.get(domainId, { rpid, bid: entry.bid });
            if (!block || (block.branch || 'main') !== branch) continue;

            const parentDid = typeof entry.parentDid === 'number' ? entry.parentDid : null;
            if (parentDid === null) continue;

            await document.set(domainId, TYPE_BK, block.docId, {
                did: parentDid,
                order: typeof entry.order === 'number' ? entry.order : Number(entry.order) || 0,
            });
        }
    }
}

/**
 * Handle repo MCP tool calls (internal)
 */
async function handleRepoMcpToolCall(domainId: string, toolName: string, args: any, agentId?: string, agentName?: string): Promise<any> {
    const match = toolName.match(/^repo_(\d+)_(.+)$/);
    if (!match) {
        throw new Error(`Invalid repo tool name: ${toolName}`);
    }

    const rpid = parseInt(match[1], 10);
    const operation = match[2];
    const branch = args.branch || 'main';
    
    const checkMainBranchModification = (operationType: string): void => {
        if (branch === 'main' && ['create', 'edit', 'delete', 'update'].some(op => operationType.includes(op))) {
            throw new Error(`Cannot perform ${operationType} operation on main branch. Please use create_branch to create a new branch first, then perform operations on the new branch.`);
        }
    };
    
    const generateCommitMessage = async (customMessage?: string, purpose?: string): Promise<string> => {
        const prefix = `${domainId}/agent(${agentId})`;
        
        let message = prefix;
        if (purpose && purpose.trim()) {
            message = `${message} [${purpose.trim()}]`;
        }
        
        if (customMessage && customMessage.trim()) {
            return `${message}: ${customMessage.trim()}`;
        }
        return message;
    };
    
    const commitChanges = async (commitMessage?: string, purpose?: string) => {
    };

    const applyStructureUpdates = async (domainId: string, rpid: number, branch: string, structure: any) => {
        const docEntries = Array.isArray(structure?.docs) ? structure.docs : [];
        const blockEntries = Array.isArray(structure?.blocks) ? structure.blocks : [];

        const docCache = new Map<number, string>();

        const sortedDocs = docEntries
            .filter((entry: any) => entry && typeof entry.did === 'number')
            .sort((a: any, b: any) => {
                const levelA = typeof a.level === 'number' ? a.level : Number(a.level) || 0;
                const levelB = typeof b.level === 'number' ? b.level : Number(b.level) || 0;
                if (levelA !== levelB) return levelA - levelB;
                const orderA = typeof a.order === 'number' ? a.order : Number(a.order) || 0;
                const orderB = typeof b.order === 'number' ? b.order : Number(b.order) || 0;
                if (orderA !== orderB) return orderA - orderB;
                return a.did - b.did;
            });

        for (const entry of sortedDocs) {
            const did = entry.did as number;
            const doc = await DocModel.get(domainId, { rpid, did } as any);
            if (!doc || (doc.branch || 'main') !== branch) continue;

            const parentDidValue = typeof entry.parentDid === 'number'
                ? entry.parentDid
                : (entry.parentDid === null ? null : undefined);

            let parentPath = '';
            if (typeof parentDidValue === 'number') {
                if (docCache.has(parentDidValue)) {
                    parentPath = docCache.get(parentDidValue)!;
                } else {
                    const parentDoc = await DocModel.get(domainId, { rpid, did: parentDidValue } as any);
                    if (parentDoc && (parentDoc.branch || 'main') === branch) {
                        parentPath = parentDoc.path || '';
                        docCache.set(parentDidValue, parentPath);
                    } else {
                        parentPath = '';
                    }
                }
            }

            const newPath = parentPath ? `${parentPath}/${did}` : `/${did}`;
            const updatePayload: any = {
                parentId: typeof parentDidValue === 'number' ? parentDidValue : null,
                order: typeof entry.order === 'number' ? entry.order : Number(entry.order) || 0,
                path: newPath,
            };

            await document.set(domainId, TYPE_DC, doc.docId, updatePayload);
            docCache.set(did, newPath);
        }

        for (const entry of blockEntries) {
            if (!entry || typeof entry.bid !== 'number') continue;
            const block = await BlockModel.get(domainId, { rpid, bid: entry.bid });
            if (!block || (block.branch || 'main') !== branch) continue;

            const parentDid = typeof entry.parentDid === 'number' ? entry.parentDid : null;
            if (parentDid === null) continue;

            await document.set(domainId, TYPE_BK, block.docId, {
                did: parentDid,
                order: typeof entry.order === 'number' ? entry.order : Number(entry.order) || 0,
            });
        }
    };

    try {
        if (operation === 'query_structure') {
            const docs = await RepoModel.getDocsByRepo(domainId, rpid);
            const filteredDocs = docs.filter(doc => (doc.branch || 'main') === branch);
            
            const docMap = new Map<number, any>();
            const rootDocs: any[] = [];
            for (const doc of filteredDocs) {
                const docNode = {
                    did: doc.did,
                    title: doc.title,
                    parentDid: (doc as any).parentId || null,
                    order: (doc as any).order || 0,
                    level: (doc as any).level || 0,
                    path: (doc as any).path || '',
                    children: [] as any[],
                    blocks: [] as any[],
                };
                docMap.set(doc.did, docNode);
            }
            
            for (const docNode of docMap.values()) {
                if (docNode.parentDid && docMap.has(docNode.parentDid)) {
                    docMap.get(docNode.parentDid)!.children.push(docNode);
                } else {
                    rootDocs.push(docNode);
                }
            }
            
            for (const docNode of docMap.values()) {
                const blocks = await BlockModel.getByDid(domainId, docNode.did, rpid, branch);
                docNode.blocks = blocks.map(block => ({
                    bid: block.bid,
                    title: block.title,
                    content: block.content,
                    order: (block as any).order || 0,
                }));
            }
            
            const sortNodes = (nodes: any[]) => {
                nodes.sort((a, b) => a.order - b.order);
                for (const node of nodes) {
                    if (node.children.length > 0) {
                        sortNodes(node.children);
                    }
                }
            };
            sortNodes(rootDocs);
            
            return { 
                success: true, 
                data: {
                    docs: rootDocs,
                    note: 'doc is folder/directory structure for organizing content; block is the actual content block containing specific content data.'
                }
            };
        }
        
        if (operation === 'update_structure') {
            if (!args.structure) {
                return { success: false, message: 'structure is required' };
            }
            
            await applyStructureUpdates(domainId, rpid, branch, args.structure);
            await commitChanges(args.commitMessage);
            
            return { success: true, message: 'Structure updated and committed' };
        }
        
        if (operation === 'query_branches') {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            const remoteUrl = (repo as any)?.githubUrl;
            
            const repoGitPath = getRepoGitPath(domainId, rpid);
            const localBranches: any[] = [];
            const remoteBranches: any[] = [];
            
            try {
                await exec('git rev-parse --git-dir', { cwd: repoGitPath });
                try {
                    const { stdout: localBranchList } = await exec('git branch', { cwd: repoGitPath });
                    const branches = localBranchList.trim().split('\n').map(b => b.replace(/^\*\s*/, '').trim()).filter(Boolean);
                    for (const branchName of branches) {
                        const status = await getGitStatus(domainId, rpid, branchName, remoteUrl);
                        localBranches.push({
                            name: branchName,
                            ...status,
                        });
                    }
                } catch {}
                
                if (remoteUrl) {
                    try {
                        await exec('git fetch origin', { cwd: repoGitPath }).catch(() => {});
                        const { stdout: remoteBranchList } = await exec('git branch -r', { cwd: repoGitPath });
                        const branches = remoteBranchList.trim().split('\n')
                            .map(b => b.replace(/^origin\//, '').trim())
                            .filter(b => b && !b.includes('HEAD'));
                        for (const branchName of branches) {
                            if (!localBranches.find(b => b.name === branchName)) {
                                const status = await getGitStatus(domainId, rpid, branchName, remoteUrl);
                                remoteBranches.push({
                                    name: branchName,
                                    ...status,
                                });
                            }
                        }
                    } catch {}
                }
            } catch {
            }
            
            if (args.branch) {
                const targetBranch = localBranches.find(b => b.name === args.branch) || remoteBranches.find(b => b.name === args.branch);
                return { 
                    success: true, 
                    data: targetBranch || { name: args.branch, hasLocalRepo: false, hasLocalBranch: false }
                };
            }
            
            return { 
                success: true, 
                data: {
                    localBranches,
                    remoteBranches,
                }
            };
        }
        
        if (operation === 'sync_branch') {
            const syncBranch = args.branch || 'main';
            const autoPull = args.autoPull !== false;
            
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            const githubRepo = (repo.githubRepo || '') as string;
            if (!githubRepo) {
                return { success: false, message: 'No remote repository configured' };
            }
            
            const repoGitPath = getRepoGitPath(domainId, rpid);
            try {
                await exec('git rev-parse --git-dir', { cwd: repoGitPath });
            } catch {
                return { success: false, message: 'Not a git repository' };
            }
            
            try {
                const GH_TOKEN = system.get('ejunzrepo.github_token') || '';
                let remoteUrl = githubRepo;
                if (githubRepo.startsWith('git@')) {
                    remoteUrl = githubRepo;
                } else {
                    if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                        if (githubRepo.includes('@github.com')) {
                            remoteUrl = githubRepo;
                        } else if (GH_TOKEN) {
                            remoteUrl = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                                .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                        } else {
                            remoteUrl = githubRepo;
                        }
                    } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                        const repoPath = githubRepo.replace('.git', '');
                        if (GH_TOKEN) {
                            remoteUrl = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
                        } else {
                            remoteUrl = `https://github.com/${repoPath}.git`;
                        }
                    }
                }
                
                try {
                    await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                }
                
                try {
                    await exec(`git checkout ${syncBranch}`, { cwd: repoGitPath });
                } catch {
                    return { success: false, message: `Branch ${syncBranch} not found` };
                }
                
                try {
                    await exec('git fetch origin', { cwd: repoGitPath });
                } catch {}
                
                let hasRemoteBranch = false;
                let behind = 0;
                let ahead = 0;
                
                try {
                    await exec(`git rev-parse --verify origin/${syncBranch}`, { cwd: repoGitPath });
                    hasRemoteBranch = true;
                    
                    try {
                        const { stdout: behindCount } = await exec(`git rev-list --count ${syncBranch}..origin/${syncBranch}`, { cwd: repoGitPath });
                        behind = parseInt(behindCount.trim()) || 0;
                    } catch {
                        behind = 0;
                    }
                    
                    try {
                        const { stdout: aheadCount } = await exec(`git rev-list --count origin/${syncBranch}..${syncBranch}`, { cwd: repoGitPath });
                        ahead = parseInt(aheadCount.trim()) || 0;
                    } catch {
                        ahead = 0;
                    }
                } catch {
                    hasRemoteBranch = false;
                }
                
                if (hasRemoteBranch && behind > 0 && autoPull) {
                    try {
                        await exec(`git pull origin ${syncBranch}`, { cwd: repoGitPath });
                        
                        await clearRepoBranchData(domainId, rpid, syncBranch);
                        await importGitStructureToEjunz(domainId, rpid, repoGitPath, 0, '127.0.0.1', syncBranch);
                        
                        return {
                            success: true,
                            message: `Auto-pulled remote updates (local behind ${behind} commits) and synced to database`,
                            data: {
                                branch: syncBranch,
                                behind: 0,
                                ahead,
                                hasRemoteBranch: true,
                                pulled: true,
                                synced: true,
                            },
                        };
                    } catch (pullError: any) {
                        return {
                            success: false,
                            message: `Pull failed: ${pullError.message || 'may have conflicts that need manual resolution'}`,
                            data: {
                                branch: syncBranch,
                                behind,
                                ahead,
                                hasRemoteBranch: true,
                            },
                        };
                    }
                }
                
                return {
                    success: true,
                    message: hasRemoteBranch 
                        ? (behind > 0 ? `Local behind remote by ${behind} commits` : ahead > 0 ? `Local ahead of remote by ${ahead} commits` : 'Local and remote are in sync')
                        : 'Remote branch does not exist',
                    data: {
                        branch: syncBranch,
                        behind,
                        ahead,
                        hasRemoteBranch,
                        needsPull: behind > 0 && !autoPull,
                        needsPush: ahead > 0,
                    },
                };
            } catch (error: any) {
                return { success: false, message: error.message || 'Sync failed' };
            }
        }
        
        if (operation === 'pull') {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            const githubRepo = (repo.githubRepo || '') as string;
            if (!githubRepo) {
                return { success: false, message: 'No remote repository configured' };
            }
            
            const repoGitPath = getRepoGitPath(domainId, rpid);
            try {
                await exec('git rev-parse --git-dir', { cwd: repoGitPath });
            } catch {
                return { success: false, message: 'Not a git repository' };
            }
            
            try {
                const GH_TOKEN = system.get('ejunzrepo.github_token') || '';
                let remoteUrl = githubRepo;
                if (githubRepo.startsWith('git@')) {
                    remoteUrl = githubRepo;
                } else {
                    if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                        if (githubRepo.includes('@github.com')) {
                            remoteUrl = githubRepo;
                        } else if (GH_TOKEN) {
                            remoteUrl = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                                .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                        } else {
                            remoteUrl = githubRepo;
                        }
                    } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                        const repoPath = githubRepo.replace('.git', '');
                        if (GH_TOKEN) {
                            remoteUrl = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
                        } else {
                            remoteUrl = `https://github.com/${repoPath}.git`;
                        }
                    }
                }
                
                try {
                    await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                }
                
                try {
                    await exec(`git checkout ${branch}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                }
                
                await exec(`git pull origin ${branch}`, { cwd: repoGitPath });
                
                await clearRepoBranchData(domainId, rpid, branch);
                await importGitStructureToEjunz(domainId, rpid, repoGitPath, 0, '127.0.0.1', branch);
                
                return { success: true, message: `Pulled from remote branch ${branch} and synced to database` };
            } catch (error: any) {
                return { success: false, message: error.message || 'Pull failed' };
            }
        }
        
        if (operation === 'push') {
            const repo = await RepoModel.getRepoByRpid(domainId, rpid);
            const githubRepo = (repo.githubRepo || '') as string;
            if (!githubRepo) {
                return { success: false, message: 'No remote repository configured' };
            }
            
            const GH_TOKEN = system.get('ejunzrepo.github_token') || '';
            
            let remoteUrl = githubRepo;
            if (githubRepo.startsWith('git@')) {
                remoteUrl = githubRepo;
            } else {
                if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                    if (githubRepo.includes('@github.com')) {
                        remoteUrl = githubRepo;
                    } else if (GH_TOKEN) {
                        remoteUrl = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                            .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                    } else {
                        remoteUrl = githubRepo;
                    }
                } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                    const repoPath = githubRepo.replace('.git', '');
                    if (GH_TOKEN) {
                        remoteUrl = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
                    } else {
                        remoteUrl = `https://github.com/${repoPath}.git`;
                    }
                }
            }
            
            const repoGitPath = getRepoGitPath(domainId, rpid);
            try {
                await exec('git rev-parse --git-dir', { cwd: repoGitPath });
            } catch {
                return { success: false, message: 'Not a git repository' };
            }
            
            try {
                try {
                    await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                }
                
                try {
                    await exec(`git checkout ${branch}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                }
                
                try {
                    const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
                    if (statusOutput.trim().length > 0) {
                        await exec('git add -A', { cwd: repoGitPath });
                        const defaultMessage = await generateCommitMessage(undefined, args.purpose);
                        const escapedMessage = defaultMessage.replace(/'/g, "'\\''");
                        await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
                    }
                } catch {}
                
                try {
                    await exec('git fetch origin', { cwd: repoGitPath });
                } catch {
                }
                
                try {
                    await exec(`git push -u origin ${branch}:${branch}`, { cwd: repoGitPath });
                    return { success: true, message: `Pushed to remote branch ${branch} (created if not exists)` };
                } catch (pushError: any) {
                    try {
                        const { stdout: remoteBranches } = await exec('git ls-remote --heads origin', { cwd: repoGitPath });
                        const branchExists = remoteBranches.includes(`refs/heads/${branch}`);
                        
                        if (!branchExists) {
                            await exec(`git push -u origin ${branch}`, { cwd: repoGitPath });
                            return { success: true, message: `Created and pushed remote branch ${branch}` };
                        } else {
                            throw pushError;
                        }
                    } catch (retryError: any) {
                        return { success: false, message: `Push failed: ${retryError.message || pushError.message}` };
                    }
                }
            } catch (error: any) {
                return { success: false, message: error.message || 'Push failed' };
            }
        }
        
        const generateUrl = (type: 'doc' | 'block', targetId: number, did?: number): string => {
            const domainPrefix = domainId !== 'system' ? `/d/${domainId}` : '';
            if (type === 'doc') {
                return `${domainPrefix}/base/repo/${rpid}/branch/${branch}/doc/${targetId}`;
            } else {
                if (!did) {
                    return `${domainPrefix}/base/repo/${rpid}/branch/${branch}/doc/${did || 0}/block/${targetId}`;
                }
                return `${domainPrefix}/base/repo/${rpid}/branch/${branch}/doc/${did}/block/${targetId}`;
            }
        };
        
        if (operation === 'ask') {
            const question = args.question || '';
            const limit = args.limit || 10;
            
            if (!question.trim()) {
                return { success: false, message: 'Question is required' };
            }
            
            const [docResults, blockResults] = await Promise.all([
                RepoKeywordIndexModel.search(domainId, rpid, branch, question, 'doc', limit, 0),
                RepoKeywordIndexModel.search(domainId, rpid, branch, question, 'block', limit, 0),
            ]);
            
            const allResults = [
                ...docResults.results.map(r => ({ ...r, type: 'doc' as const })),
                ...blockResults.results.map(r => ({ ...r, type: 'block' as const })),
            ].sort((a, b) => b.score - a.score).slice(0, limit);
            
            const enrichedResults = await Promise.all(
                allResults.map(async (result) => {
                    let fullData: any = null;
                    let url = '';
                    
                    if (result.type === 'doc') {
                        fullData = await DocModel.get(domainId, { rpid, did: result.targetId });
                        if (fullData) {
                            url = generateUrl('doc', result.targetId);
                        }
                    } else {
                        fullData = await BlockModel.get(domainId, { rpid, bid: result.targetId, branch });
                        if (fullData) {
                            url = generateUrl('block', result.targetId, fullData.did);
                        }
                    }
                    
                    return {
                        type: result.type,
                        targetId: result.targetId,
                        title: result.title,
                        contentSnippet: result.contentSnippet,
                        score: result.score,
                        matchedKeywords: result.matchedKeywords,
                        url,
                        fullData: fullData || null,
                    };
                })
            );
            
            const answerParts: Array<{ text: string; url: string; title: string }> = [];
            const references: Array<{ title: string; url: string; snippet: string; type: 'doc' | 'block' }> = [];
            
            enrichedResults.forEach((result, index) => {
                if (result.fullData) {
                    const snippet = result.contentSnippet || result.fullData.content?.substring(0, 200) || '';
                    const cleanSnippet = snippet.replace(/\n+/g, ' ').trim();
                    
                    const linkText = `[${result.title}](${result.url})`;
                    answerParts.push({
                        text: `${index + 1}. ${linkText}\n   ${cleanSnippet}...`,
                        url: result.url,
                        title: result.title,
                    });
                    
                    references.push({
                        title: result.title,
                        url: result.url,
                        snippet: cleanSnippet.substring(0, 150),
                        type: result.type,
                    });
                }
            });
            
            let answer = '';
            if (answerParts.length > 0) {
                answer = `Based on your question "${question}", I found the following relevant content:\n\n`;
                answer += answerParts.map(part => part.text).join('\n\n');
                answer += `\n\nFound ${answerParts.length} relevant results.`;
            } else {
                answer = `Sorry, no content related to "${question}" was found.`;
            }
            
            return {
                success: true,
                data: {
                    question,
                    answer,
                    references,
                    results: enrichedResults,
                    total: docResults.total + blockResults.total,
                    answerMarkdown: answer,
                    structuredAnswer: answerParts.map(part => ({
                        text: part.text,
                        url: part.url,
                        title: part.title,
                    })),
                },
            };
        }
        
        const searchMatch = operation.match(/^search_(doc|block)$/);
        if (searchMatch) {
            const type = searchMatch[1] as 'doc' | 'block';
            const keywords = args.keywords || '';
            const limit = args.limit || 50;
            const skip = args.skip || 0;
            
            if (!keywords.trim()) {
                return { success: false, message: 'Keywords are required for search' };
            }
            
            const searchResult = await RepoKeywordIndexModel.search(
                domainId,
                rpid,
                branch,
                keywords,
                type,
                limit,
                skip
            );
            
            const enrichedResults = await Promise.all(
                searchResult.results.map(async (result) => {
                    let fullData: any = null;
                    let url = '';
                    
                    if (result.type === 'doc') {
                        fullData = await DocModel.get(domainId, { rpid, did: result.targetId });
                        if (fullData) {
                            url = generateUrl('doc', result.targetId);
                        }
                    } else {
                        fullData = await BlockModel.get(domainId, { rpid, bid: result.targetId, branch });
                        if (fullData) {
                            url = generateUrl('block', result.targetId, fullData.did);
                        }
                    }
                    
                    return {
                        ...result,
                        fullData: fullData || null,
                        url,
                    };
                })
            );
            
            return {
                success: true,
                data: {
                    results: enrichedResults,
                    total: searchResult.total,
                    limit,
                    skip,
                },
            };
        }
        
        if (operation === 'create_branch') {
            const branchName = args.branchName || '';
            const purpose = args.purpose || '';
            
            if (!branchName || branchName.trim() === '') {
                return { success: false, message: 'Branch name cannot be empty' };
            }
            
            if (branchName === 'main') {
                return { success: false, message: 'Cannot create branch named main' };
            }
            
            try {
                const repo = await RepoModel.getRepoByRpid(domainId, rpid);
                if (!repo) {
                    return { success: false, message: 'Repo not found' };
                }
                
                const branches = Array.isArray(repo.branches) ? repo.branches.slice() : [];
                if (!branches.includes(branchName)) {
                    branches.push(branchName);
                    await document.set(domainId, TYPE_RP, repo.docId, { branches });
                }
                
                try {
                    const repoGitPath = await ensureRepoGitRepo(domainId, rpid);
                    await exec(`git checkout main`, { cwd: repoGitPath });
                    await exec(`git checkout -b ${branchName}`, { cwd: repoGitPath });
                } catch (err) {
                    console.error('Failed to create git branch:', err);
                }
                
                try {
                    await cloneBranchData(domainId, rpid, 'main', branchName, 0, '127.0.0.1');
                } catch (err) {
                    console.error('Failed to clone branch data:', err);
                }
                
                return {
                    success: true,
                    message: `Branch ${branchName} created successfully`,
                    data: {
                        branchName,
                        purpose,
                        agentId,
                        agentName,
                    },
                };
            } catch (error: any) {
                return { success: false, message: error.message || 'Failed to create branch' };
            }
        }
        
        if (operation === 'commit') {
            const commitBranch = args.branch || branch;
            const purpose = args.purpose || '';
            
            if (commitBranch === 'main') {
                return { success: false, message: 'Cannot commit to main branch' };
            }
            
            try {
                const repoGitPath = getRepoGitPath(domainId, rpid);
                try {
                    await exec('git rev-parse --git-dir', { cwd: repoGitPath });
                } catch {
                    return { success: false, message: 'Not a git repository' };
                }
                
                try {
                    await exec(`git checkout ${commitBranch}`, { cwd: repoGitPath });
                } catch {
                    return { success: false, message: `Branch ${commitBranch} not found` };
                }
                
                const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
                if (statusOutput.trim().length === 0) {
                    return { success: false, message: 'No changes to commit' };
                }
                
                await exec('git add -A', { cwd: repoGitPath });
                const commitMessage = await generateCommitMessage(args.message, purpose);
                const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
                
                return {
                    success: true,
                    message: `Commit successful`,
                    data: {
                        branch: commitBranch,
                        commitMessage,
                        purpose,
                        agentId,
                        agentName,
                    },
                };
            } catch (error: any) {
                return { success: false, message: error.message || 'Failed to commit' };
            }
        }
        
        if (operation === 'push') {
            const pushBranch = args.branch || branch;
            const purpose = args.purpose || '';
            
            if (pushBranch === 'main') {
                return { success: false, message: 'Cannot push to main branch' };
            }
            
            try {
                const repoGitPath = await ensureRepoGitRepo(domainId, rpid);
                
                try {
                    const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
                    if (statusOutput.trim().length > 0) {
                        await exec('git add -A', { cwd: repoGitPath });
                        const commitMessage = await generateCommitMessage('Auto commit before push', purpose);
                        const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                        await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
                    }
                } catch (err) {
                    console.error('Failed to auto commit before push:', err);
                }
                
                try {
                    await exec(`git checkout ${pushBranch}`, { cwd: repoGitPath });
                } catch {
                    return { success: false, message: `Branch ${pushBranch} does not exist` };
                }
                
                let remoteUrl = '';
                try {
                    const { stdout } = await exec('git remote get-url origin', { cwd: repoGitPath });
                    remoteUrl = stdout.trim();
                } catch {
                    return { success: false, message: 'Remote repository URL not configured' };
                }
                
                try {
                    await exec(`git push -u origin ${pushBranch}`, { cwd: repoGitPath });
                } catch {
                    try {
                        await exec(`git push origin ${pushBranch}`, { cwd: repoGitPath });
                    } catch (err: any) {
                        return { success: false, message: `Push failed: ${err.message || err}` };
                    }
                }
                
                return {
                    success: true,
                    message: `Pushed to remote successfully`,
                    data: {
                        branch: pushBranch,
                        purpose,
                        agentId,
                        agentName,
                    },
                };
            } catch (error: any) {
                return { success: false, message: error.message || 'Failed to push' };
            }
        }
        
        if (operation === 'update_structure') {
            checkMainBranchModification('update_structure');
            await applyStructureUpdates(domainId, rpid, branch, args.structure);
            return { success: true, message: 'Structure updated' };
        }
        
        const docBlockMatch = operation.match(/^(query|create|edit|delete)_(doc|block)$/);
        if (!docBlockMatch) {
            throw new Error(`Unsupported operation: ${operation}`);
        }
        
        const op = docBlockMatch[1];
        const type = docBlockMatch[2];
        
        if (type === 'doc') {
            if (op === 'query') {
                if (args.did) {
                    const doc = await DocModel.get(domainId, { rpid, did: args.did });
                    if (!doc || (doc.branch || 'main') !== branch) {
                        return { success: false, message: 'Document not found' };
                    }
                    return { success: true, data: doc };
                } else {
                    const docs = await RepoModel.getDocsByRepo(domainId, rpid);
                    const filteredDocs = docs.filter(doc => (doc.branch || 'main') === branch);
                    return { success: true, data: filteredDocs };
                }
            } else if (op === 'create') {
                checkMainBranchModification('create_doc');
                const did = await DocModel.generateNextDid(domainId, rpid, branch);
                let docId: ObjectId;
                if (args.parentId) {
                    docId = await DocModel.addSubdocNode(
                        domainId,
                        [rpid],
                        did,
                        args.parentId,
                        0,
                        args.title,
                        args.content,
                        undefined,
                        branch
                    );
                } else {
                    docId = await DocModel.addRootNode(
                        domainId,
                        rpid,
                        did,
                        0,
                        args.title,
                        args.content,
                        undefined,
                        branch
                    );
                }
                const doc = await DocModel.get(domainId, docId);
                return { success: true, data: doc };
            } else if (op === 'edit') {
                checkMainBranchModification('edit_doc');
                const doc = await DocModel.get(domainId, { rpid, did: args.did });
                if (!doc || (doc.branch || 'main') !== branch) {
                    return { success: false, message: 'Document not found' };
                }
                const update: any = {};
                if (args.title !== undefined) update.title = args.title;
                if (args.content !== undefined) update.content = args.content;
                if (Object.keys(update).length > 0) {
                    await DocModel.edit(domainId, doc.docId, update.title || doc.title, update.content || doc.content);
                }
                const updatedDoc = await DocModel.get(domainId, { rpid, did: args.did });
                return { success: true, data: updatedDoc };
            } else if (op === 'delete') {
                checkMainBranchModification('delete_doc');
                const doc = await DocModel.get(domainId, { rpid, did: args.did });
                if (!doc || (doc.branch || 'main') !== branch) {
                    return { success: false, message: 'Document not found' };
                }
                await DocModel.deleteNode(domainId, doc.docId);
                return { success: true, message: 'Document deleted' };
            }
        } else if (type === 'block') {
            if (op === 'query') {
                if (args.bid) {
                    const block = await BlockModel.get(domainId, { rpid, bid: args.bid, branch });
                    if (!block) {
                        return { success: false, message: 'Block not found' };
                    }
                    return { success: true, data: block };
                } else {
                    const query: any = {};
                    if (args.did) query.did = args.did;
                    const blocks = await BlockModel.getByDid(domainId, args.did || 0, rpid, branch);
                    return { success: true, data: blocks };
                }
            } else if (op === 'create') {
                checkMainBranchModification('create_block');
                if (!args.did) {
                    return { success: false, message: 'did is required for creating block' };
                }
                const docId = await BlockModel.create(
                    domainId,
                    rpid,
                    args.did,
                    0,
                    args.title,
                    args.content,
                    undefined,
                    branch
                );
                const block = await BlockModel.get(domainId, docId);
                return { success: true, data: block };
            } else if (op === 'edit') {
                checkMainBranchModification('edit_block');
                const block = await BlockModel.get(domainId, { rpid, bid: args.bid, branch });
                if (!block) {
                    return { success: false, message: 'Block not found' };
                }
                const updateTitle = args.title !== undefined ? args.title : block.title;
                const updateContent = args.content !== undefined ? args.content : block.content;
                await BlockModel.edit(domainId, block.docId, updateTitle, updateContent);
                const updatedBlock = await BlockModel.get(domainId, { rpid, bid: args.bid, branch });
                return { success: true, data: updatedBlock };
            } else if (op === 'delete') {
                checkMainBranchModification('delete_block');
                const block = await BlockModel.get(domainId, { rpid, bid: args.bid, branch });
                if (!block) {
                    return { success: false, message: 'Block not found' };
                }
                await BlockModel.delete(domainId, block.docId);
                return { success: true, message: 'Block deleted' };
            }
        }
    } catch (error: any) {
        return { success: false, message: error.message || 'Operation failed' };
    }

    throw new Error(`Unsupported operation: ${operation}`);
}

export async function apply(ctx: Context) {
    (ctx as any).on('mcp/tool/call/repo' as any, async (data: { name: string; args: any; domainId?: string; agentId?: string; agentName?: string }) => {
        const domainId = data.domainId || ctx.domain?._id;
        if (!domainId) {
            throw new Error('Domain ID is required');
        }
        return await handleRepoMcpToolCall(domainId, data.name, data.args, data.agentId, data.agentName);
    });

    ctx.Route('base_domain', '/base', BaseDomainHandler);
    ctx.Route('base_edit', '/base/:docId/edit', BaseEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_create', '/base/create', BaseEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_create', '/base/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/base/repo/:rpid', RepoDetailHandler);
    ctx.Route('repo_detail_branch', '/base/repo/:rpid/branch/:branch', RepoDetailHandler);
    ctx.Route('repo_structure_update', '/base/repo/:rpid/update_structure', RepoStructureUpdateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_edit', '/base/repo/:rpid/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_mcp', '/base/repo/:rpid/mcp', RepoMcpHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create', '/base/repo/:rpid/doc/create', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create_branch', '/base/repo/:rpid/branch/:branch/doc/create', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create_subdoc', '/base/repo/:rpid/doc/:parentId/createsubdoc', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create_subdoc_branch', '/base/repo/:rpid/branch/:branch/doc/:parentId/createsubdoc', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_detail', '/base/repo/:rpid/doc/:did', DocDetailHandler);
    ctx.Route('doc_detail_branch', '/base/repo/:rpid/branch/:branch/doc/:did', DocDetailHandler);
    ctx.Route('doc_edit', '/base/repo/:rpid/doc/:docId/editdoc', DocEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_github_push', '/base/repo/:rpid/github/push', RepoGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_github_push_branch', '/base/repo/:rpid/branch/:branch/github/push', RepoGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_github_pull', '/base/repo/:rpid/github/pull', RepoGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_github_pull_branch', '/base/repo/:rpid/branch/:branch/github/pull', RepoGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_branch_create', '/base/repo/:rpid/branch/create', RepoBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_branch_create_with_param', '/base/repo/:rpid/branch/:branch/create', RepoBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_branch_switch', '/base/repo/:rpid/branch/switch', RepoBranchSwitchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_mode_switch', '/base/repo/:rpid/mode/:mode', RepoModeSwitchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_mode_switch_branch', '/base/repo/:rpid/branch/:branch/mode/:mode', RepoModeSwitchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_manuscript_batch_update', '/base/repo/:rpid/branch/:branch/manuscript/batch-update', RepoManuscriptBatchUpdateHandler, PRIV.PRIV_USER_PROFILE);
    // Block routes
    ctx.Route('block_create', '/base/repo/:rpid/doc/:did/block/create', BlockCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('block_create_branch', '/base/repo/:rpid/branch/:branch/doc/:did/block/create', BlockCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('block_detail', '/base/repo/:rpid/doc/:did/block/:bid', BlockDetailHandler);
    ctx.Route('block_detail_branch', '/base/repo/:rpid/branch/:branch/doc/:did/block/:bid', BlockDetailHandler);
    ctx.Route('block_edit', '/base/repo/:rpid/doc/:did/block/:bid/edit', BlockEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('block_edit_branch', '/base/repo/:rpid/branch/:branch/doc/:did/block/:bid/edit', BlockEditHandler, PRIV.PRIV_USER_PROFILE);
}

