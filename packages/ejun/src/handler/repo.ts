import _ from 'lodash';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, Types } from '../service/server';
import { NotFoundError } from '../error';
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
import { BaseModel, RepoModel, DocModel, BlockModel, TYPE_BS, TYPE_RP, TYPE_DC, TYPE_BK } from '../model/repo';
import type { BSDoc, RPDoc, DCDoc, BKDoc } from '../interface';
import * as setting from '../model/setting';
import https from 'https';
import http from 'http';

const exec = promisify(execCb);

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
        
        // 自动创建对应的 git 仓库
        try {
            await ensureRepoGitRepo(domainId, rpid);
            
            // 尝试在远程 GitHub 组织中创建仓库并推送
            try {
                await createAndPushToGitHubOrg(this, domainId, rpid, title, this.user);
            } catch (err) {
                // 创建远程仓库失败不影响本地 repo 创建
                console.error('Failed to create remote GitHub repo:', err);
            }
        } catch (err) {
            // 创建 git 仓库失败不影响 repo 创建
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
  
      // 若未显式传入分支，重定向到带分支的URL，默认使用 main
      if (!branch || !String(branch).trim()) {
        const target = this.url('repo_detail_branch', { domainId, rpid, branch: 'main' });
        this.response.redirect = target;
        return;
      }
  
      const requestedBranch = branch;
      
      const repoDocsAll = await RepoModel.getDocsByRepo(domainId, repo.rpid);
      const repoDocs = repoDocsAll.filter(d => (d.branch || 'main') === requestedBranch);
      const rootDocs = repoDocs.filter(doc => doc.parentId === null);
  
      const allDocsWithBlocks = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did, undefined, requestedBranch);
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

      // 获取完整的 git 状态信息
      let gitStatus: any = null;
      const githubRepo = (repo.githubRepo || '') as string;
      if (githubRepo && githubRepo.trim()) {
        try {
          // 处理仓库地址
          let REPO_URL = githubRepo;
          if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
          } else {
            // HTTPS/HTTP 格式，需要 token
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

          // 获取完整的 git 状态
          gitStatus = await getGitStatus(domainId, repo.rpid, requestedBranch, REPO_URL);
        } catch (err) {
          console.error('Failed to get git status:', err);
          gitStatus = null;
        }
      } else {
        // 即使没有配置远程仓库，也检查本地 git 状态
        try {
          gitStatus = await getGitStatus(domainId, repo.rpid, requestedBranch);
        } catch (err) {
          console.error('Failed to get local git status:', err);
          gitStatus = null;
        }
      }
      
      // 为了向后兼容，保留 branchStatus
      const branchStatus = gitStatus ? {
        behind: gitStatus.behind || 0,
        ahead: gitStatus.ahead || 0,
        hasRemote: gitStatus.hasRemote || false
      } : null;

      // 根据模式选择模板
      const mode = (repo as any).mode || 'file';
      if (mode === 'manuscript') {
        // 文稿模式：构建完整的文档树和内容
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
        // 文件模式：使用原有模板
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
      // 传递用户信息用于生成默认 commit message
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
     * 构建文稿模式的数据结构
     */
    private async buildManuscriptData(domainId: string, rpid: number, branch: string, repoDocs: DCDoc[]) {
      // 构建带编号的目录树
      let docCounter = 0;
      let blockCounter = 0;
      
      const buildTOC = (parentId: number | null, level: number = 0, parentNumber: string = ''): any[] => {
        const children = repoDocs.filter(doc => doc.parentId === parentId);
        return children.map((doc, index) => {
          docCounter++;
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          const docBlocks = repoDocs.filter(d => false); // 这里需要获取blocks，稍后处理
          
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

      // 构建完整内容（按顺序）
      const buildContent = (parentId: number | null): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => {
            // 简单的排序，可以根据需要改进
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
          
          // 添加该doc下的blocks
          // 这里需要异步获取blocks，稍后处理
          
          // 递归添加子文档
          result.push(...buildContent(doc.did));
        }
        return result;
      };

      // 获取所有blocks
      const allBlocksMap: { [did: number]: BKDoc[] } = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did, rpid, branch);
        if (blocks && blocks.length > 0) {
          // 按bid排序
          allBlocksMap[doc.did] = blocks.sort((a, b) => (a.bid || 0) - (b.bid || 0));
        }
      }

      // 重新构建TOC，包含blocks
      // 编号规则：doc用数字，block用字母（如 1, 1.1, 1.1.a, 1.1.b, 1.2）
      const buildTOCWithBlocks = (parentId: number | null, level: number = 0, parentNumber: string = ''): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => (a.did || 0) - (b.did || 0));
        
        const tocItems: any[] = [];
        children.forEach((doc, index) => {
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          const blocks = allBlocksMap[doc.did] || [];
          
          // 构建blocks项（作为doc的子项，使用字母编号）
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
          
          // 递归添加子文档（子文档继续使用数字编号）
          const subDocs = buildTOCWithBlocks(doc.did, level + 1, number);
          
          // 添加doc项，包含blocks和子文档
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

      // 构建完整内容（带编号）
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
          
          // 添加该doc下的blocks（使用字母编号）
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
          
          // 递归添加子文档
          result.push(...buildContentWithBlocks(doc.did, number));
        });
        return result;
      };

      const toc = buildTOCWithBlocks(null);
      const content = buildContentWithBlocks(null, '');

      return {
        toc,
        content,
        // 传递原始数据用于编辑
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

        // 组合默认消息和用户自定义消息
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;

        try {
            // 先处理删除
            if (deletes && Array.isArray(deletes) && deletes.length > 0) {
                await this.deleteItems(domainId, rpid, deletes, effectiveBranch);
            }
            // 然后处理创建
            if (creates && creates.length > 0) {
                await this.createItems(domainId, rpid, creates, effectiveBranch);
            }
            // 处理标题更新
            if (updates && Array.isArray(updates) && updates.length > 0) {
                await this.updateItems(domainId, rpid, updates, effectiveBranch);
            }
            // 最后更新结构
            await this.updateDocStructure(domainId, rpid, structure.docs);
            
            // 提交到 git
            try {
                await commitRepoChanges(domainId, rpid, effectiveBranch, finalCommitMessage, this.user._id, this.user.uname || '');
            } catch (err) {
                // 提交失败不影响保存操作
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
                const doc = await DocModel.get(domainId, { rpid, did });
                if (doc && (doc.branch || 'main') === branch) {
                    await DocModel.edit(domainId, doc.docId, title, doc.content);
                }
            } else if (type === 'block' && bid && title) {
                const block = await BlockModel.get(domainId, { rpid, bid });
                if (block && (block.branch || 'main') === branch) {
                    await BlockModel.edit(domainId, block.docId, title, block.content);
                }
            }
        }
    }

    async deleteItems(domainId: string, rpid: number, deletes: any[], branch: string) {
        for (const deleteItem of deletes) {
            const { type, did, bid } = deleteItem;
            
            if (type === 'doc' && did) {
                // 删除文档及其所有子文档和 blocks
                const doc = await DocModel.get(domainId, { rpid, did });
                if (doc && (doc.branch || 'main') === branch) {
                    // 使用 deleteNode 会递归删除所有子节点
                    await DocModel.deleteNode(domainId, doc.docId);
                }
            } else if (type === 'block' && bid) {
                // 删除 block
                const block = await BlockModel.get(domainId, { rpid, bid });
                if (block && (block.branch || 'main') === branch) {
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

    async updateDocStructure(domainId: string, rpid: number, docs: any[], parentDid: number | null = null) {
        for (const docData of docs) {
            const { did, order, subDocs, blocks } = docData;

            // 更新文档的父节点和顺序
            const doc = await DocModel.get(domainId, { rpid, did });
            if (!doc) {
                
                continue;
            }

            

            const docIdentifier = (doc as any).docId ?? (doc as any)._id;
            if (!docIdentifier) {
                continue;
            }

            // 使用 document.set 更新文档
            await document.set(domainId, TYPE_DC, docIdentifier, {
                parentId: parentDid,
                order: order || 0,
                updateAt: new Date()
            });

            // 更新 blocks 的顺序和父文档
            if (blocks && blocks.length > 0) {
                for (const blockData of blocks) {
                    const bid = blockData.bid;
                    const blockOrder = blockData.order;
                    
                    // 使用 rpid + bid 来唯一标识 block（bid 在整个 repo 内唯一）
                    const block = await BlockModel.get(domainId, { rpid, bid });
                    
                    if (block) {
                        
                        const blockIdentifier = (block as any).docId ?? (block as any)._id;
                        if (!blockIdentifier) {
                            continue;
                        }

                        await document.set(domainId, TYPE_BK, blockIdentifier, {
                            did: did,  // 更新 block 的父文档 ID
                            order: blockOrder || 0,
                            updateAt: new Date()
                        });
                    } else {
                        
                    }
                }
            }

            // 递归处理子文档
            if (subDocs && subDocs.length > 0) {
                await this.updateDocStructure(domainId, rpid, subDocs, did);
            }
        }
    }
}

// Removed: DocCreateSubdocHandler - unified with DocCreateHandler



// Removed: DocEditHandler and DocResourceEditHandler - resource management removed from doc

export class DocEditHandler extends DocHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        const ddoc = await DocModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Doc with docId ${docId} not found.`);
        }

        this.response.template = 'doc_edit.html';
        this.response.body = {
            ddoc,
            rpid: this.args.rpid,
        };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('commitMessage', Types.String, true)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string, commitMessage?: string) {
        const doc = await DocModel.get(domainId, docId);
        if (!doc || !doc.rpid) {
            throw new NotFoundError(`Doc with docId ${docId} not found or has no rpid.`);
        }

        await DocModel.edit(domainId, docId, title, content);
        
        // 提交到 git
        const branch = (doc as any).branch || 'main';
        // 组合默认消息和用户自定义消息
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;
        try {
            await commitRepoChanges(domainId, doc.rpid, branch, finalCommitMessage, this.user._id, this.user.uname || '');
        } catch (err) {
            // 提交失败不影响保存操作
            console.error('Failed to commit changes:', err);
        }
 
        this.response.body = { docId, did: doc.did };
        this.response.redirect = this.url('doc_detail', { rpid: doc.rpid, did: doc.did });
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
        const block = await BlockModel.get(domainId, { rpid, bid });
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
    async get(domainId: string, rpid: number, did: number, bid: number) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        this.response.template = 'block_edit.html';
        this.response.body = {
            block,
            rpid: block.rpid,
            did: block.did
        };
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('commitMessage', Types.String, true)
    async postUpdate(domainId: string, rpid: number, did: number, bid: number, title: string, content: string, commitMessage?: string) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        await BlockModel.edit(domainId, block.docId, title, content);
        
        // 提交到 git
        const branch = (block as any).branch || 'main';
        // 组合默认消息和用户自定义消息
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;
        try {
            await commitRepoChanges(domainId, rpid, branch, finalCommitMessage, this.user._id, this.user.uname || '');
        } catch (err) {
            // 提交失败不影响保存操作
            console.error('Failed to commit changes:', err);
        }

        this.response.body = { bid };
        this.response.redirect = this.url('block_detail', { rpid, did, bid });
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async postDelete(domainId: string, rpid: number, did: number, bid: number) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        await BlockModel.delete(domainId, block.docId);
        
        this.response.redirect = this.url('doc_detail', { rpid, did });
    }
}

/**
 * 检查远程分支状态，返回本地分支落后远程分支的 commit 数量
 */
async function checkRemoteBranchStatus(githubRepo: string, branch: string): Promise<{ behind: number; ahead: number; hasRemote: boolean } | null> {
    if (!githubRepo || githubRepo.trim() === '') {
        return null;
    }
    
    // 处理仓库地址
    let REPO_URL = githubRepo;
    if (!githubRepo.startsWith('git@') && !githubRepo.startsWith('https://') && !githubRepo.startsWith('http://')) {
        // 简单格式，需要转换为完整 URL（但这里我们无法获取 token，所以只检查 SSH 或完整 URL）
        return null;
    }
    
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-check-remote-'));
    try {
        // 尝试克隆或获取远程信息
        try {
            await exec(`git clone --bare ${REPO_URL} .`, { cwd: tmpDir });
        } catch {
            // 克隆失败，可能没有权限或仓库不存在
            return null;
        }
        
        // 检查远程分支是否存在
        try {
            await exec(`git ls-remote --heads origin ${branch}`, { cwd: tmpDir });
        } catch {
            // 远程分支不存在
            return { behind: 0, ahead: 0, hasRemote: false };
        }
        
        // 获取远程分支的最新 commit
        const { stdout: remoteCommit } = await exec(`git rev-parse origin/${branch}`, { cwd: tmpDir });
        const remoteCommitHash = remoteCommit.trim();
        
        // 由于我们没有本地仓库，无法直接比较，所以返回 null
        // 实际比较需要在有本地仓库的情况下进行
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
 * 获取或创建 repo 的 git 仓库路径
 */
function getRepoGitPath(domainId: string, rpid: number): string {
    return path.join('/data/git/ejunz', domainId, String(rpid));
}

/**
 * 初始化或获取 repo 的 git 仓库
 */
export async function ensureRepoGitRepo(domainId: string, rpid: number, remoteUrl?: string): Promise<string> {
    const repoPath = getRepoGitPath(domainId, rpid);
    
    // 确保目录存在
    await fs.promises.mkdir(repoPath, { recursive: true });
    
    // 检查是否已经是 git 仓库
    try {
        await exec('git rev-parse --git-dir', { cwd: repoPath });
        // 已经是 git 仓库
        if (remoteUrl) {
            // 更新远程仓库 URL
            try {
                await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath });
            } catch {
                // 如果远程不存在，添加它
                try {
                    await exec(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
                } catch {
                    // 忽略错误
                }
            }
        }
    } catch {
        // 不是 git 仓库，初始化
        await exec('git init', { cwd: repoPath });
        await exec('git config user.name "ejunz-bot"', { cwd: repoPath });
        await exec('git config user.email "bot@ejunz.local"', { cwd: repoPath });
        
        if (remoteUrl) {
            await exec(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
        }
    }
    
    return repoPath;
}

/**
 * 使用 GitHub API 在组织中创建仓库
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
            auto_init: false, // 不自动初始化，我们稍后会推送内容
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
                    // 仓库可能已存在，尝试获取现有仓库信息
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
 * 在 GitHub 组织中创建仓库并推送本地内容
 */
async function createAndPushToGitHubOrg(
    handler: any,
    domainId: string,
    rpid: number,
    repoTitle: string,
    user: any
): Promise<void> {
    // 获取 GitHub 组织配置（从系统设置）
    const githubOrg = system.get('ejunzrepo.github_org') || '';
    if (!githubOrg || !githubOrg.trim()) {
        // 没有配置组织，跳过
        return;
    }

    // 处理组织名称（支持 URL 格式）
    let orgName = githubOrg.trim();
    if (orgName.startsWith('https://github.com/')) {
        orgName = orgName.replace('https://github.com/', '').replace(/\/$/, '');
    } else if (orgName.startsWith('http://github.com/')) {
        orgName = orgName.replace('http://github.com/', '').replace(/\/$/, '');
    } else if (orgName.startsWith('@')) {
        orgName = orgName.substring(1);
    }
    orgName = orgName.split('/')[0]; // 只取组织名，忽略路径

    if (!orgName) {
        return;
    }

    // 获取 GitHub token
    const settingValue = handler.ctx.setting.get('ejunzrepo.github_token');
    const systemValue = system.get('ejunzrepo.github_token');
    const GH_TOKEN = settingValue || systemValue || '';
    if (!GH_TOKEN) {
        console.warn('GitHub token not configured, skipping remote repo creation');
        return;
    }

    // 生成仓库名称（使用 repo title，清理特殊字符）
    const repoName = repoTitle
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || `repo-${rpid}`;

    try {
        // 使用 GitHub API 创建仓库
        const remoteUrl = await createGitHubRepo(orgName, repoName, repoTitle, GH_TOKEN, false);
        
        if (!remoteUrl) {
            throw new Error('Failed to get remote repository URL');
        }

        // 处理远程 URL（确保使用 HTTPS 格式并包含 token）
        let REPO_URL = remoteUrl;
        if (remoteUrl.startsWith('git@')) {
            // SSH 格式，保持原样
            REPO_URL = remoteUrl;
        } else if (remoteUrl.startsWith('https://')) {
            // HTTPS 格式，插入 token
            if (!remoteUrl.includes('@github.com')) {
                REPO_URL = remoteUrl.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`);
            }
        }

        // 更新 repo，保存远程仓库地址
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (repo) {
            await document.set(domainId, TYPE_RP, repo.docId, {
                githubRepo: REPO_URL,
            });
        }

        // 构建本地 repo 内容并推送到远程
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-create-'));
        try {
            await buildLocalRepoFromEjunz(domainId, rpid, tmpDir, 'main');
            
            // 使用 gitInitAndPush 推送内容
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
 * 提交变更到 git 仓库（在保存操作后调用）
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
    
    // 检查是否是 git 仓库
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        // 不是 git 仓库，初始化
        await ensureRepoGitRepo(domainId, rpid);
    }
    
    // 确保在正确的分支上
    try {
        await exec(`git checkout ${branch}`, { cwd: repoGitPath });
    } catch {
        // 分支不存在，创建新分支
        await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
    }
    
    // 从数据库构建文件结构到临时目录
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-commit-'));
    try {
        await buildLocalRepoFromEjunz(domainId, rpid, tmpDir, branch);
        
        // 复制文件到 git 仓库（排除 .git）
        await copyDir(tmpDir, repoGitPath);
        
        // 添加所有变更
        await exec('git add -A', { cwd: repoGitPath });
        
        // 检查是否有变更
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (stdout.trim()) {
                // 有变更，提交
                // commitMessage 已经是最终消息（包含默认前缀和自定义部分），直接使用
                // 如果没有提供消息，使用默认值
                const finalMessage = commitMessage && commitMessage.trim() 
                    ? commitMessage.trim()
                    : `${domainId}/${userId}/${userName || 'unknown'}`;
                const escapedMessage = finalMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            }
        } catch {
            // 忽略错误
        }
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {}
    }
}

/**
 * 获取完整的 git 状态信息（本地和远程）
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
        // 检查是否是 git 仓库
        try {
            await exec('git rev-parse --git-dir', { cwd: repoGitPath });
        } catch {
            return defaultStatus; // 不是 git 仓库
        }
        
        const status: any = {
            ...defaultStatus,
            hasLocalRepo: true,
        };
        
        // 获取当前分支
        try {
            const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
            status.currentBranch = currentBranch.trim();
        } catch {}
        
        // 检查本地分支是否存在
        try {
            await exec(`git rev-parse --verify ${branch}`, { cwd: repoGitPath });
            status.hasLocalBranch = true;
            
            // 获取本地分支的 commit 数量
            try {
                const { stdout: localCount } = await exec(`git rev-list --count ${branch}`, { cwd: repoGitPath });
                status.localCommits = parseInt(localCount.trim()) || 0;
            } catch {}
            
            // 获取最后一次提交信息
            try {
                const { stdout: lastCommit } = await exec(`git rev-parse ${branch}`, { cwd: repoGitPath });
                const fullCommit = lastCommit.trim();
                status.lastCommit = fullCommit;
                status.lastCommitShort = fullCommit.substring(0, 8); // 截取前8个字符用于显示
                
                try {
                    // 使用单引号包裹格式字符串，避免 shell 解析问题
                    const { stdout: commitMessage } = await exec(`git log -1 --pretty=format:'%s' ${branch}`, { cwd: repoGitPath });
                    const fullMessage = commitMessage.trim();
                    if (fullMessage) {
                        status.lastCommitMessage = fullMessage;
                        status.lastCommitMessageShort = fullMessage.length > 50 ? fullMessage.substring(0, 50) : fullMessage;
                    }
                } catch (err) {
                    // 如果上面的命令失败，尝试另一种方式
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
        
        // 检查是否有未提交的更改
        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            status.uncommittedChanges = statusOutput.trim().length > 0;
        } catch {
            status.uncommittedChanges = false;
        }
        
        // 如果有远程 URL，检查远程状态
        if (remoteUrl) {
            try {
                // 设置或更新远程仓库 URL
                try {
                    await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                } catch {
                    try {
                        await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                    } catch {}
                }
                
                status.hasRemote = true;
                
                // 获取远程分支信息
                try {
                    // 先 fetch 所有远程分支，确保引用是最新的
                    try {
                        await exec('git fetch origin', { cwd: repoGitPath });
                    } catch {
                        // fetch 失败，尝试只 fetch 指定分支
                        await exec(`git fetch origin ${branch}`, { cwd: repoGitPath });
                    }
                    
                    // 检查远程分支是否存在
                    try {
                        await exec(`git rev-parse --verify origin/${branch}`, { cwd: repoGitPath });
                        status.hasRemoteBranch = true;
                        
                        // 获取远程分支的 commit 数量
                        try {
                            const { stdout: remoteCount } = await exec(`git rev-list --count origin/${branch}`, { cwd: repoGitPath });
                            status.remoteCommits = parseInt(remoteCount.trim()) || 0;
                        } catch {}
                        
                        // 如果本地分支存在，比较本地和远程
                        if (status.hasLocalBranch) {
                            try {
                                // 使用 --left-right 来同时计算两个方向的差异，更准确
                                const { stdout: aheadOutput } = await exec(`git rev-list --left-right --count origin/${branch}...${branch}`, { cwd: repoGitPath });
                                const parts = aheadOutput.trim().split(/\s+/);
                                if (parts.length >= 2) {
                                    // parts[0] 是远程领先的（本地落后的），parts[1] 是本地领先的（远程落后的）
                                    status.behind = parseInt(parts[0].trim()) || 0;
                                    status.ahead = parseInt(parts[1].trim()) || 0;
                                } else {
                                    // 如果 --left-right 失败，使用原来的方法分别计算
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
                                // 如果比较失败，可能是因为本地和远程没有共同祖先或分支历史不同
                                try {
                                    // 先检查是否有共同祖先
                                    await exec(`git merge-base ${branch} origin/${branch}`, { cwd: repoGitPath });
                                    // 有共同祖先，使用原来的方法分别计算
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
                                    // 没有共同祖先或计算失败，尝试使用本地和远程的提交数差值（不准确，但至少有个提示）
                                    // 注意：这只在本地和远程完全分叉时使用
                                    if (status.localCommits > 0 && status.remoteCommits > 0) {
                                        // 如果本地提交数大于远程，可能本地有更多提交
                                        // 但这不准确，因为可能不是线性关系
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
                    // fetch 失败，可能远程分支不存在或网络问题
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
 * 检查本地分支与远程分支的差异（需要本地有 git 仓库）
 */
async function checkLocalBranchStatus(repoDir: string, branch: string, remoteUrl: string): Promise<{ behind: number; ahead: number; hasRemote: boolean } | null> {
    try {
        // 检查是否是 git 仓库
        try {
            await exec('git rev-parse --git-dir', { cwd: repoDir });
        } catch {
            return null; // 不是 git 仓库
        }
        
        // 设置远程仓库（如果还没有）
        try {
            await exec('git remote get-url origin', { cwd: repoDir });
        } catch {
            // 没有远程仓库，添加一个
            await exec(`git remote add origin ${remoteUrl}`, { cwd: repoDir });
        }
        
        // 获取远程分支信息
        try {
            await exec(`git fetch origin ${branch}`, { cwd: repoDir });
        } catch {
            // 获取失败，可能远程分支不存在
            return { behind: 0, ahead: 0, hasRemote: false };
        }
        
        // 检查本地分支是否存在
        try {
            await exec(`git rev-parse --verify ${branch}`, { cwd: repoDir });
        } catch {
            // 本地分支不存在
            return { behind: 0, ahead: 0, hasRemote: true };
        }
        
        // 比较本地和远程分支
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

// GitHub 同步工具
async function buildLocalRepoFromEjunz(domainId: string, rpid: number, targetDir: string, branch: string = 'main') {
    const repo = await RepoModel.getRepoByRpid(domainId, rpid);
    if (!repo) throw new Error(`Repo not found: rpid=${rpid}`);
    const docsAll = await RepoModel.getDocsByRepo(domainId, rpid);
    const docs = docsAll.filter(d => (d.branch || 'main') === branch);

    // 为了安全与跨平台，文件名做基本清洗
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';

    // 建立 did -> children 的映射
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

    // 递归创建目录与 block 文件（名称包含编号）
    async function writeDocTree(parentId: number|null, parentPath: string) {
        const list = sortDocs(childrenMap.get(parentId) || []);
        for (const d of list) {
            const dirName = sanitize(d.title);
            const curDir = path.join(parentPath, dirName);
            await fs.promises.mkdir(curDir, { recursive: true });

            // 写入 doc 的 content 到该目录的 README.md
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

            // 若没有 blocks 且没有子文档，创建占位文件，避免空目录不被 git 跟踪
            const children = childrenMap.get(d.did) || [];
            if (blocks.length === 0 && children.length === 0) {
                const keepPath = path.join(curDir, '.keep');
                await fs.promises.writeFile(keepPath, '', 'utf8');
            }

            await writeDocTree(d.did, curDir);
        }
    }

    // 直接从仓库根开始写，不再建立 doc 根目录
    await writeDocTree(null, targetDir);

    // 写入 repo 的 content 到仓库根目录的 README.md
    await fs.promises.writeFile(
        path.join(targetDir, 'README.md'),
        repo.content || `# ${repo.title}\n\nThis repo is generated by ejunzrepo.`,
        'utf8'
    );
}

/**
 * 将源目录的内容复制到目标目录（覆盖），排除 .git 目录
 */
async function copyDir(src: string, dest: string) {
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        // 排除 .git 目录，避免覆盖 Git 历史
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
 * Git 版本控制推送：使用实际的 git 仓库
 */
async function gitInitAndPush(
    domainId: string,
    rpid: number,
    sourceDir: string, 
    remoteUrlWithAuth: string, 
    branch: string = 'main', 
    commitMessage: string = 'chore: sync from ejunzrepo'
) {
    // 使用实际的 git 仓库路径
    const repoGitPath = await ensureRepoGitRepo(domainId, rpid, remoteUrlWithAuth);
    let isNewRepo = false;
    
    try {
        // 检查是否是新的 git 仓库（没有 commit）
        try {
            await exec('git rev-parse HEAD', { cwd: repoGitPath });
            isNewRepo = false;
        } catch {
            isNewRepo = true;
        }
        
        // 如果仓库是新的或没有远程分支，尝试从远程克隆或拉取
        if (isNewRepo) {
            try {
                // 尝试从远程克隆（如果远程仓库存在）
                const tmpCloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-clone-'));
                try {
                    await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmpCloneDir });
                    // 复制 .git 目录到实际仓库
                    await fs.promises.cp(path.join(tmpCloneDir, '.git'), path.join(repoGitPath, '.git'), { recursive: true });
                    isNewRepo = false;
                } catch {
                    // 远程仓库不存在，保持 isNewRepo = true
                } finally {
                    try {
                        await fs.promises.rm(tmpCloneDir, { recursive: true, force: true });
                    } catch {}
                }
            } catch {}
        } else {
            // 获取所有远程分支
            try {
                await exec('git fetch origin', { cwd: repoGitPath });
            } catch {}
        }
        
        // 检查目标分支是否存在（本地或远程）
        try {
            await exec(`git checkout ${branch}`, { cwd: repoGitPath });
        } catch {
            // 本地分支不存在，尝试从远程创建
            try {
                await exec(`git checkout -b ${branch} origin/${branch}`, { cwd: repoGitPath });
            } catch {
                // 远程分支也不存在，从当前分支（通常是 main 或 master）创建新分支
                try {
                    const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                    const baseBranch = currentBranch.trim() || 'main';
                    await exec(`git checkout -b ${branch} ${baseBranch}`, { cwd: repoGitPath });
                } catch {
                    // 如果当前分支也不存在，直接创建新分支
                    await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                }
            }
        }
        
        // 拉取最新内容（如果分支已存在且不是新仓库）
        if (!isNewRepo) {
            try {
                await exec(`git pull origin ${branch}`, { cwd: repoGitPath });
            } catch {
                // 如果 pull 失败（可能是新分支），忽略
            }
        }
        
        // 如果不是新仓库，先删除所有已跟踪的文件（除了 .git），以便正确反映删除
        if (!isNewRepo) {
            try {
                // 获取所有已跟踪的文件（排除 .git）
                const { stdout: trackedFiles } = await exec('git ls-files', { cwd: repoGitPath });
                const files = trackedFiles.trim().split('\n').filter(f => f && !f.startsWith('.git/'));
                // 删除这些文件
                for (const file of files) {
                    const filePath = path.join(repoGitPath, file);
                    try {
                        await fs.promises.unlink(filePath);
                    } catch {
                        // 文件可能不存在或已被删除，忽略
                    }
                }
                // 删除所有空目录（除了 .git）
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
                                    // 目录不为空或不存在，忽略
                                }
                            }
                        }
                    } catch {
                        // 忽略错误
                    }
                };
                await deleteEmptyDirs(repoGitPath);
            } catch {
                // 如果清理失败，继续执行
            }
        }
        
        // 将源目录的内容复制到仓库目录（覆盖）
        await copyDir(sourceDir, repoGitPath);
        
        // 添加所有变更（包括删除）- 使用 -A 或 --all 来包含删除操作
        await exec('git add -A', { cwd: repoGitPath });
        
        // 检查是否有变更需要提交
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (stdout.trim()) {
                // 有变更，提交
                const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            }
        } catch (err) {
            // 如果 status 失败，尝试直接提交
            const escapedMessage = commitMessage.replace(/'/g, "'\\''");
            try {
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            } catch {
                // 没有变更，忽略
            }
        }
        
        // 推送：如果是新仓库或新分支，使用 -u；否则正常推送
        if (isNewRepo) {
            await exec(`git push -u origin ${branch}`, { cwd: repoGitPath });
        } else {
            try {
                await exec(`git push origin ${branch}`, { cwd: repoGitPath });
            } catch {
                // 如果推送失败（可能是分支不存在），使用 -u
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
    // 直接从仓库根读取；没有专门的 doc 目录
    const exists = await fs.promises
        .stat(localDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
    if (!exists) return;

    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim();

    // 读取仓库根目录的 README.md 更新 repo.content
    const repoReadmePath = path.join(localDir, 'README.md');
    try {
        const repoContent = await fs.promises.readFile(repoReadmePath, 'utf8');
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (repo) {
            // 更新 repo 的 content，保留 config
            await document.set(domainId, TYPE_RP, repo.docId, {
                content: repoContent
            });
        }
    } catch (err) {
        // README.md 不存在或读取失败，忽略
    }

    async function ensureDoc(parentDid: number|null, dirPath: string, dirName: string): Promise<number> {
        const title = sanitize(dirName) || 'untitled';
        let did: number;
        
        // 读取该目录下的 README.md 作为 doc.content
        const docReadmePath = path.join(dirPath, 'README.md');
        let docContent = '';
        try {
            docContent = await fs.promises.readFile(docReadmePath, 'utf8');
        } catch (err) {
            // README.md 不存在，使用空字符串
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
        // 先处理 md 文件为 block（排除 README.md，因为它已经作为 doc.content）
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
                if (parentDid == null) continue;
                const content = await fs.promises.readFile(path.join(currentDir, e.name), 'utf8');
                const nameWithout = e.name.replace(/\.md$/i, '');
                const title = sanitize(nameWithout) || 'untitled';
                await BlockModel.create(domainId, rpid, parentDid, userId, title, content, ip, branch);
            }
        }
        // 再处理子目录为子 doc
        for (const e of entries) {
            if (e.isDirectory()) {
                const childDirPath = path.join(currentDir, e.name);
                const childDid = await ensureDoc(parentDid, childDirPath, e.name);
                await walk(childDid, childDirPath);
            }
        }
    }

    // 仓库根下的每个目录（排除 .git 等）作为一个 root doc
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
    // 读取源分支的所有文档
    const allDocs = await RepoModel.getDocsByRepo(domainId, rpid);
    const sourceDocs = allDocs.filter(d => (d.branch || 'main') === sourceBranch);
    if (sourceDocs.length === 0) return;

    // 旧 did -> 新 did
    const didMap = new Map<number, number>();

    // 按路径深度从浅到深，确保父先于子
    const sortedDocs = sourceDocs.slice().sort((a, b) => (a.path?.split('/').length || 1) - (b.path?.split('/').length || 1));

    for (const d of sortedDocs) {
        const isRoot = d.parentId == null;
        if (isRoot) {
            const newDid = await DocModel.generateNextDid(domainId, rpid, targetBranch);
            await DocModel.addRootNode(domainId, rpid, newDid, d.owner || userId, d.title, d.content || '', ip, targetBranch);
            didMap.set(d.did, newDid);
        } else {
            const parentNewDid = didMap.get(d.parentId!);
            if (parentNewDid == null) continue; // 父节点缺失，跳过
            const newDid = await DocModel.generateNextDid(domainId, rpid, targetBranch);
            await DocModel.addSubdocNode(domainId, [rpid], newDid, parentNewDid, d.owner || userId, d.title, d.content || '', ip, targetBranch);
            didMap.set(d.did, newDid);
        }

        // 复制该文档下的 blocks
        const blocks = await BlockModel.getByDid(domainId, d.did, rpid, sourceBranch);
        const newDid = didMap.get(d.did)!;
        for (const b of blocks) {
            await BlockModel.create(domainId, rpid, newDid, b.owner || userId, b.title, b.content || '', ip, targetBranch);
        }
    }
}
/**
 * 清空指定 repo+branch 的本地数据（docs 与 blocks）。
 */
async function clearRepoBranchData(domainId: string, rpid: number, branch: string) {
    // 删除 blocks
    const blocks = await document.getMulti(domainId, TYPE_BK, { rpid, branch }).toArray();
    for (const b of blocks) {
        await document.deleteOne(domainId, TYPE_BK, b.docId);
    }
    // 删除 docs
    const docs = await document.getMulti(domainId, TYPE_DC, { rpid, branch }).toArray();
    for (const d of docs) {
        await document.deleteOne(domainId, TYPE_DC, d.docId);
    }
}
// (deprecated old RepoGithubPushHandler removed)


// PR/Push：将 ejunzrepo 结构推送到指定 GitHub 仓库
export class RepoGithubPushHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        
        // 从 system 配置读取 GitHub token（优先域配置，再回落系统配置）
        const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
        const systemValue = system.get('ejunzrepo.github_token');
        const GH_TOKEN = settingValue || systemValue || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        
        // 从 repo 配置读取仓库地址（优先从 config，向后兼容 githubRepo 字段）
        const githubRepo = (repo.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in repo settings.');
        }
        
        // 处理仓库地址：SSH 格式直接使用，HTTPS/HTTP 格式使用 token，简单格式转换为 HTTPS
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            // SSH 格式：git@github.com:user/repo.git，直接使用
            REPO_URL = githubRepo;
        } else {
            // HTTPS/HTTP 格式或简单格式，需要 token
            if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                // 已经是完整的 HTTPS/HTTP URL，只需要插入 token
                if (githubRepo.includes('@github.com')) {
                    // 如果已经包含 token，直接使用
                    REPO_URL = githubRepo;
                } else {
                    // 插入 token
                    REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                        .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                // 如果没有协议和 @，假设是 user/repo 格式，转换为 HTTPS
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        // 直接推送已有的 commit，不需要重新构建或提交
        const repoGitPath = await ensureRepoGitRepo(domainId, rpid, REPO_URL);
        
        try {
            // 确保在正确的分支上
            try {
                await exec(`git checkout ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                // 分支不存在，创建新分支
                await exec(`git checkout -b ${effectiveBranch}`, { cwd: repoGitPath });
            }
            
            // 设置或更新远程仓库 URL
            try {
                await exec(`git remote set-url origin ${REPO_URL}`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec(`git remote add origin ${REPO_URL}`, { cwd: repoGitPath });
                } catch {}
            }
            
            // 获取远程分支信息
            try {
                await exec('git fetch origin', { cwd: repoGitPath });
            } catch {}
            
            // 检查是否有未推送的 commit
            try {
                const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
                const hasUncommittedChanges = statusOutput.trim().length > 0;
                
                // 如果有未提交的更改，先提交（使用默认消息）
                if (hasUncommittedChanges) {
                    await exec('git add -A', { cwd: repoGitPath });
                    const defaultMessage = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
                    const escapedMessage = defaultMessage.replace(/'/g, "'\\''");
                    await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
                }
                
                // 检查是否有未推送的 commit
                try {
                    await exec(`git rev-parse --verify origin/${effectiveBranch}`, { cwd: repoGitPath });
                    // 远程分支存在，检查是否有未推送的 commit
                    const { stdout: aheadCount } = await exec(`git rev-list --count origin/${effectiveBranch}..${effectiveBranch}`, { cwd: repoGitPath });
                    const ahead = parseInt(aheadCount.trim()) || 0;
                    
                    if (ahead > 0) {
                        // 有未推送的 commit，直接推送
                        await exec(`git push origin ${effectiveBranch}`, { cwd: repoGitPath });
                    } else {
                        // 没有未推送的 commit，尝试推送（可能是新分支）
                        try {
                            await exec(`git push -u origin ${effectiveBranch}`, { cwd: repoGitPath });
                        } catch {
                            // 如果推送失败，可能没有需要推送的内容
                        }
                    }
                } catch {
                    // 远程分支不存在，使用 -u 推送新分支
                    await exec(`git push -u origin ${effectiveBranch}`, { cwd: repoGitPath });
                }
            } catch (err) {
                // 如果检查失败，尝试直接推送
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

// Pull：从 GitHub 仓库拉取并在 ejunz 中创建结构
export class RepoGithubPullHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        // 从 repo 配置读取仓库地址（优先从 config，向后兼容 githubRepo 字段）
        const githubRepo = (repo.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in repo settings.');
        }
        
        // 处理仓库地址：SSH 格式直接使用，HTTPS/HTTP 格式使用 token，简单格式转换为 HTTPS
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            // SSH 格式：git@github.com:user/repo.git，直接使用（不需要 token）
            REPO_URL = githubRepo;
        } else {
            // HTTPS/HTTP 格式或简单格式，需要 token
            const GH_TOKEN = this.ctx.setting.get('ejunzrepo.github_token') || '';
            if (!GH_TOKEN) {
                throw new Error('GitHub token not configured. Please configure it in system settings.');
            }
            
            if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                // 已经是完整的 HTTPS/HTTP URL，只需要插入 token
                if (githubRepo.includes('@github.com')) {
                    // 如果已经包含 token，直接使用
                    REPO_URL = githubRepo;
                } else {
                    // 插入 token
                    REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                        .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                // 如果没有协议和 @，假设是 user/repo 格式，转换为 HTTPS
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        // 使用实际的 git 仓库
        const repoGitPath = await ensureRepoGitRepo(domainId, rpid, REPO_URL);
        
        try {
            // 获取远程分支信息
            try {
                await exec(`git fetch origin ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                throw new Error(`Failed to fetch remote branch ${effectiveBranch}`);
            }
            
            // 检查本地分支是否存在
            try {
                await exec(`git rev-parse --verify ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                // 本地分支不存在，从远程创建
                await exec(`git checkout -b ${effectiveBranch} origin/${effectiveBranch}`, { cwd: repoGitPath });
            }
            
            // 切换到目标分支并拉取最新内容
            await exec(`git checkout ${effectiveBranch}`, { cwd: repoGitPath });
            await exec(`git reset --hard origin/${effectiveBranch}`, { cwd: repoGitPath });

            // 先清空本地该分支的数据，以正确反映远端的删除
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

// 分支管理：创建与切换
export class RepoBranchCreateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async post(domainId: string, rpid: number, branch: string) {
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        const branches = Array.isArray(repo.branches) ? repo.branches.slice() : [];
        const newBranch = (branch || '').trim() || 'main';
        if (!branches.includes(newBranch)) branches.push(newBranch);
        await document.set(domainId, TYPE_RP, repo.docId, { branches, currentBranch: newBranch });

        const sourceBranch = repo.currentBranch || 'main';
        try {
            await cloneBranchData(domainId, rpid, sourceBranch, newBranch, this.user._id, this.request.ip);
        } catch (e) {
            console.error('cloneBranchData failed:', e);
        }

        // 在 git 仓库中创建对应的分支
        try {
            const repoGitPath = await ensureRepoGitRepo(domainId, rpid);
            
            // 检查新分支是否已存在
            let branchExists = false;
            try {
                await exec(`git rev-parse --verify ${newBranch}`, { cwd: repoGitPath });
                branchExists = true;
            } catch {
                branchExists = false;
            }
            
            if (branchExists) {
                // 分支已存在，切换到该分支
                await exec(`git checkout ${newBranch}`, { cwd: repoGitPath });
            } else {
                // 分支不存在，需要创建
                // 首先确定源分支（用于创建新分支）
                let actualSourceBranch = sourceBranch;
                
                // 检查源分支是否存在
                try {
                    await exec(`git rev-parse --verify ${sourceBranch}`, { cwd: repoGitPath });
                } catch {
                    // 源分支不存在，尝试使用 main
                    try {
                        await exec(`git rev-parse --verify main`, { cwd: repoGitPath });
                        actualSourceBranch = 'main';
                    } catch {
                        // main 也不存在，检查是否有任何 commit
                        try {
                            await exec('git rev-parse HEAD', { cwd: repoGitPath });
                            // 有 commit，获取当前分支名
                            const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                            actualSourceBranch = currentBranch.trim() || 'main';
                        } catch {
                            // 没有 commit，无法创建分支，跳过
                            throw new Error('No commits found, cannot create branch');
                        }
                    }
                }
                
                // 从源分支创建新分支
                try {
                    await exec(`git checkout ${actualSourceBranch}`, { cwd: repoGitPath });
                    await exec(`git checkout -b ${newBranch}`, { cwd: repoGitPath });
                } catch (err) {
                    // 如果创建失败，可能是分支名无效或其他原因
                    throw err;
                }
            }
        } catch (err) {
            // git 分支创建失败不影响数据库操作，只记录错误
            console.error('Failed to create git branch:', err);
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

// 模式切换 Handler
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

// 文稿模式批量更新 Handler
export class RepoManuscriptBatchUpdateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const repo = await RepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        
        const effectiveBranch = branch || repo.currentBranch || 'main';
        const { updates, creates, deletes, commitMessage } = this.request.body;
        
        // 组合默认消息和用户自定义消息
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = commitMessage && commitMessage.trim() 
            ? `${defaultPrefix}: ${commitMessage.trim()}`
            : defaultPrefix;
        
        try {
            // 处理删除
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
            
            // 处理更新
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
            
            // 处理创建
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
            
            // 提交到 git
            try {
                await commitRepoChanges(domainId, rpid, effectiveBranch, finalCommitMessage, this.user._id, this.user.uname || '');
            } catch (err) {
                // 提交失败不影响保存操作
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

export async function apply(ctx: Context) {

    ctx.Route('base_domain', '/base', BaseDomainHandler);
    ctx.Route('base_edit', '/base/:docId/edit', BaseEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_create', '/base/create', BaseEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_create', '/base/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/base/repo/:rpid', RepoDetailHandler);
    ctx.Route('repo_detail_branch', '/base/repo/:rpid/branch/:branch', RepoDetailHandler);
    ctx.Route('repo_structure_update', '/base/repo/:rpid/update_structure', RepoStructureUpdateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_edit', '/base/repo/:rpid/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create', '/base/repo/:rpid/doc/create', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create_branch', '/base/repo/:rpid/branch/:branch/doc/create', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create_subdoc', '/base/repo/:rpid/doc/:parentId/createsubdoc', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_create_subdoc_branch', '/base/repo/:rpid/branch/:branch/doc/:parentId/createsubdoc', DocCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('doc_detail', '/base/repo/:rpid/doc/:did', DocDetailHandler);
    ctx.Route('doc_detail_branch', '/base/repo/:rpid/branch/:branch/doc/:did', DocDetailHandler);
    ctx.Route('doc_edit', '/base/repo/:rpid/doc/:docId/editdoc', DocEditHandler, PRIV.PRIV_USER_PROFILE);
    // Added: GitHub同步
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

    ctx.i18n.load('zh', {
        base_domain: '基础',
        repo_create: '创建仓库',
        repo_detail: '仓库详情',
        repo_edit: '编辑仓库信息',
        repo_doc: '仓库文档',
        doc_create: '创建文档',
        doc_create_subdoc: '创建子文档',
        doc_detail: '文档详情',  
        doc_edit: '编辑文档',
        block_create: '创建块',
        block_detail: '块详情',
        block_edit: '编辑块',
        'File Mode': '文件模式',
        'Manuscript Mode': '文稿模式',
        'Table of Contents': '目录',
        'Edit': '编辑',
        'View': '查看',
        'Save': '保存',
        'Cancel': '取消',
        'Doc': '文档',
        'Block': '块',
        'Add Root Doc': '添加根文档',
        'Remove': '删除',
        'No content': '无内容',
        'No changes to save': '没有更改需要保存',
        'Saved successfully': '保存成功',
        'Save failed': '保存失败',
        'Saving': '保存中',
        'Title': '标题',
        'Content': '内容',
        'Number': '编号',
        'New': '新建',
        'Folder/Directory': '文件夹/目录',
        'Content Block': '内容块',
        'Description': '描述',
        'Optional': '可选',
        'Folder description': '文件夹描述',
        'New Folder': '新建文件夹',
        'New Content Block': '新建内容块',
        'Drop here to delete': '拖到这里删除',
        'Enter new title': '输入新标题',
        'Enter title for new': '输入新',
        'Add New': '添加新项',
        'File': '文件',
        'Manuscript': '文稿',
        'Remote Branch Status': '远程分支状态',
        'This branch is behind remote by {0} commit(s). Please use Pull to sync.': '此分支落后远程 {0} 个提交。请使用 Pull 同步。',
        'Remote branch exists. Use Pull to sync with remote changes.': '远程分支存在。使用 Pull 同步远程更改。',
        'Git Status': 'Git 状态',
        'Local Repository': '本地仓库',
        'Local Branch': '本地分支',
        'Remote Repository': '远程仓库',
        'Remote Branch': '远程分支',
        'commits': '提交',
        'Uncommitted changes': '未提交的更改',
        'Last Commit': '最后提交',
        'Local branch not found': '本地分支未找到',
        'Remote branch not found': '远程分支未找到',
        'Push will create a new remote branch': '推送将创建新的远程分支',
        'Create remote branch': '创建远程分支',
        'No remote repository configured': '未配置远程仓库',
        'No local git repository': '无本地 git 仓库',
        'Behind remote by {0} commit(s)': '落后远程 {0} 个提交',
        'Ahead of remote by {0} commit(s)': '领先远程 {0} 个提交',
        'Up to date with remote': '与远程同步',
        'No commit message': '无提交消息',
        'Commit Message': '提交消息',
        'Enter custom commit message (optional)': '请输入自定义提交消息（可选）',
        'Default message': '默认消息',
        'Final message will be': '最终消息将是',
        'your custom message': '您的自定义消息',
        'Pushing...': '推送中...',
        'Pulling...': '拉取中...',
        'Pushing to GitHub...': '正在推送到 GitHub...',
        'Pulling from GitHub...': '正在从 GitHub 拉取...',
        'Successfully pushed to GitHub': '成功推送到 GitHub',
        'Successfully pulled from GitHub': '成功从 GitHub 拉取',
        'Failed to push to GitHub': '推送到 GitHub 失败',
        'Failed to pull from GitHub': '从 GitHub 拉取失败',
    });
    ctx.i18n.load('en', {
        base_domain: 'Base',
        repo_create: 'Create Repo',
        repo_detail: 'Repo Detail',
        repo_edit: 'Edit Repo info',
        repo_doc: 'Repo Doc',
        doc_create: 'Create Doc',
        doc_create_subdoc: 'Create Subdoc',
        doc_detail: 'Doc Detail',
        doc_edit: 'Edit Doc',
        block_create: 'Create Block',
        block_detail: 'Block Detail',
        block_edit: 'Edit Block',
        'File Mode': 'File Mode',
        'Manuscript Mode': 'Manuscript Mode',
        'Table of Contents': 'Table of Contents',
        'Edit': 'Edit',
        'View': 'View',
        'Save': 'Save',
        'Cancel': 'Cancel',
        'Doc': 'Doc',
        'Block': 'Block',
        'Add Root Doc': 'Add Root Doc',
        'Remove': 'Remove',
        'No content': 'No content',
        'No changes to save': 'No changes to save',
        'Saved successfully': 'Saved successfully',
        'Save failed': 'Save failed',
        'Saving': 'Saving',
        'Title': 'Title',
        'Content': 'Content',
        'Number': 'Number',
        'New': 'New',
        'Folder/Directory': 'Folder/Directory',
        'Content Block': 'Content Block',
        'Description': 'Description',
        'Optional': 'Optional',
        'Folder description': 'Folder description',
        'New Folder': 'New Folder',
        'New Content Block': 'New Content Block',
        'Drop here to delete': 'Drop here to delete',
        'Enter new title': 'Enter new title',
        'Enter title for new': 'Enter title for new',
        'Add New': 'Add New',
        'File': 'File',
        'Manuscript': 'Manuscript',
        'Remote Branch Status': 'Remote Branch Status',
        'This branch is behind remote by {0} commit(s). Please use Pull to sync.': 'This branch is behind remote by {0} commit(s). Please use Pull to sync.',
        'Remote branch exists. Use Pull to sync with remote changes.': 'Remote branch exists. Use Pull to sync with remote changes.',
        'Git Status': 'Git Status',
        'Local Repository': 'Local Repository',
        'Local Branch': 'Local Branch',
        'Remote Repository': 'Remote Repository',
        'Remote Branch': 'Remote Branch',
        'commits': 'commits',
        'Uncommitted changes': 'Uncommitted changes',
        'Last Commit': 'Last Commit',
        'Local branch not found': 'Local branch not found',
        'Remote branch not found': 'Remote branch not found',
        'Push will create a new remote branch': 'Push will create a new remote branch',
        'Create remote branch': 'Create remote branch',
        'No remote repository configured': 'No remote repository configured',
        'No local git repository': 'No local git repository',
        'Behind remote by {0} commit(s)': 'Behind remote by {0} commit(s)',
        'Ahead of remote by {0} commit(s)': 'Ahead of remote by {0} commit(s)',
        'Up to date with remote': 'Up to date with remote',
        'No commit message': 'No commit message',
        'Commit Message': 'Commit Message',
        'Enter custom commit message (optional)': 'Enter custom commit message (optional)',
        'Default message': 'Default message',
        'Final message will be': 'Final message will be',
        'your custom message': 'your custom message',
        'Pushing...': 'Pushing...',
        'Pulling...': 'Pulling...',
        'Pushing to GitHub...': 'Pushing to GitHub...',
        'Pulling from GitHub...': 'Pulling from GitHub...',
        'Successfully pushed to GitHub': 'Successfully pushed to GitHub',
        'Successfully pulled from GitHub': 'Successfully pulled from GitHub',
        'Failed to push to GitHub': 'Failed to push to GitHub',
        'Failed to pull from GitHub': 'Failed to pull from GitHub',
    });
}

