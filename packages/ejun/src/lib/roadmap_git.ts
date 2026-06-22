import { exec as execCb, execFile as execFileCb } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError } from '../error';
import type { RoadmapDoc } from '../interface';
import { PERM, PRIV } from '../model/builtin';
import { getBranchData, readOptionalRequestBaseDocId, setBranchData } from '../model/base';
import * as document from '../model/document';
import RoadmapModel from '../model/roadmap';
import system from '../model/system';
import UserModel from '../model/user';
import { Handler, param, Types } from '../service/server';

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

const ROADMAP_JSON = 'roadmap.json';
const README_MD = 'README.md';

export function getRoadmapGitPath(domainId: string, docId: number): string {
    return path.join('/data/git/ejunz', domainId, 'roadmap', String(docId));
}

const gitSafeDirRegistered = new Set<string>();

async function ensureGitSafeDirectory(repoPath: string): Promise<string> {
    const abs = path.resolve(repoPath);
    await fs.promises.mkdir(abs, { recursive: true });
    if (gitSafeDirRegistered.has(abs)) return abs;
    try {
        const { stdout } = await execFile('git', ['config', '--global', '--get-all', 'safe.directory']);
        const existing = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
        if (!existing.includes(abs)) {
            await execFile('git', ['config', '--global', '--add', 'safe.directory', abs]);
        }
    } catch {
        try {
            await execFile('git', ['config', '--global', '--add', 'safe.directory', abs]);
        } catch { /* ignore */ }
    }
    gitSafeDirRegistered.add(abs);
    return abs;
}

async function ensureRoadmapGitRepo(domainId: string, docId: number, remoteUrl?: string): Promise<string> {
    const repoPath = getRoadmapGitPath(domainId, docId);
    await ensureGitSafeDirectory(repoPath);
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
            } catch { /* ignore */ }
        }
    }

    return repoPath;
}

function getSystemGithubToken(ctx: { setting: { get: (k: string) => unknown } }): string {
    const settingValue = ctx.setting.get('ejunzrepo.github_token');
    const systemValue = system.get('ejunzrepo.github_token');
    return String(settingValue || systemValue || '').trim();
}

async function fetchUserGithubToken(domainId: string, uid: number): Promise<string> {
    if (!uid || uid <= 0) return '';
    const u = await UserModel.getById(domainId, uid);
    if (!u) return '';
    const raw = (u as any)._udoc?.githubToken;
    return typeof raw === 'string' ? raw.trim() : '';
}

async function resolveGithubToken(
    ctx: { setting: { get: (k: string) => unknown } },
    domainId: string,
    uid: number,
    bodyToken?: unknown,
): Promise<string> {
    if (typeof bodyToken === 'string' && bodyToken.trim()) return bodyToken.trim();
    const userTok = await fetchUserGithubToken(domainId, uid);
    if (userTok) return userTok;
    return getSystemGithubToken(ctx);
}

function buildGithubRemoteUrl(githubRepo: string, token: string): string {
    const repo = (githubRepo || '').trim();
    if (!repo) return '';
    if (repo.startsWith('git@')) return repo;
    const isGitHubHttps = /^https?:\/\/.*github\.com\//.test(repo);
    if (isGitHubHttps) {
        let repoPathMatch = repo.match(/^https?:\/\/[^@]+@github\.com\/(.+)$/);
        if (!repoPathMatch) repoPathMatch = repo.match(/^https?:\/\/github\.com\/(.+)$/);
        if (repoPathMatch?.[1]) {
            const pathPart = repoPathMatch[1];
            if (!token) return `https://github.com/${pathPart}`;
            return `https://${token}@github.com/${pathPart}`;
        }
        const stripped = repo.replace(/^https?:\/\/[^@]+@github\.com\//, 'https://github.com/');
        if (!token) return stripped;
        return stripped.replace(/^https:\/\/github\.com\//, `https://${token}@github.com/`);
    }
    if (!repo.includes('://') && !repo.includes('@')) {
        const repoPath = repo.replace(/\.git$/, '');
        if (!token) return `https://github.com/${repoPath}.git`;
        return `https://${token}@github.com/${repoPath}.git`;
    }
    return repo;
}

async function resolveGithubRemoteUrlForRepo(
    ctx: { setting: { get: (k: string) => unknown } },
    domainId: string,
    uid: number,
    githubRepo: string,
    bodyToken?: unknown,
): Promise<string> {
    const tok = await resolveGithubToken(ctx, domainId, uid, bodyToken);
    return buildGithubRemoteUrl(githubRepo, tok);
}

function assertGithubPushPullToken(githubRepo: string, token: string): void {
    const r = (githubRepo || '').trim();
    if (!r) return;
    if (r.startsWith('git@')) return;
    if (!String(token || '').trim()) {
        throw new Error(
            'GitHub token is required for HTTPS remotes. Save a PAT in the editor GitHub panel (stored on your user) or set ejunzrepo.github_token.',
        );
    }
}

async function resolveRoadmapFromRequest(
    domainId: string,
    docId: number,
    req: { body?: any; query?: any },
): Promise<RoadmapDoc | null> {
    const bodyDoc = readOptionalRequestBaseDocId(req);
    if (bodyDoc) return RoadmapModel.get(domainId, bodyDoc);
    if (docId > 0) return RoadmapModel.get(domainId, docId);
    return null;
}

export function collectRoadmapBranches(roadmap: RoadmapDoc): string[] {
    const brSet = new Set<string>();
    const branchesArr: string[] = Array.isArray((roadmap as any).branches) ? (roadmap as any).branches : [];
    for (const b of branchesArr) {
        const s = String(b || '').trim();
        if (s) brSet.add(s);
    }
    const branchData: any = (roadmap as any).branchData || {};
    for (const k of Object.keys(branchData)) {
        const s = String(k || '').trim();
        if (s) brSet.add(s);
    }
    brSet.add('main');
    const branches = Array.from(brSet);
    branches.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
    return branches;
}

export async function checkoutRoadmapGitBranch(domainId: string, docId: number, branch: string): Promise<void> {
    const repoGitPath = getRoadmapGitPath(domainId, docId);
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
        try {
            await exec(`git checkout ${branch}`, { cwd: repoGitPath });
        } catch {
            try {
                await exec('git checkout main', { cwd: repoGitPath });
            } catch {
                try {
                    await exec('git checkout -b main', { cwd: repoGitPath });
                } catch { /* ignore */ }
            }
            try {
                await exec('git checkout main', { cwd: repoGitPath });
                await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
            } catch { /* ignore */ }
        }
    } catch {
        // Git repo not initialized
    }
}

export async function exportRoadmapToFile(
    roadmap: RoadmapDoc,
    outputDir: string,
    branch?: string,
): Promise<void> {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const effectiveBranch = branch || (roadmap as any).currentBranch || 'main';
    const view = RoadmapModel.withGraph(roadmap, effectiveBranch);
    const readme = `# ${view.title || 'Roadmap'}\n\n${roadmap.content || ''}`.trim();
    await fs.promises.writeFile(path.join(outputDir, README_MD), `${readme}\n`, 'utf-8');
    const payload = {
        title: view.title || 'Roadmap',
        nodes: view.nodes || [],
        edges: view.edges || [],
        layout: view.layout || {},
        viewport: view.viewport || { x: 0, y: 0, zoom: 1 },
        theme: (view as any).theme || {},
    };
    await fs.promises.writeFile(
        path.join(outputDir, ROADMAP_JSON),
        JSON.stringify(payload, null, 2),
        'utf-8',
    );
}

export async function importRoadmapFromFile(localDir: string): Promise<{
    nodes: RoadmapDoc['nodes'];
    edges: RoadmapDoc['edges'];
    layout?: RoadmapDoc['layout'];
    viewport?: RoadmapDoc['viewport'];
    theme?: Record<string, any>;
    content?: string;
}> {
    const jsonPath = path.join(localDir, ROADMAP_JSON);
    let nodes: RoadmapDoc['nodes'] = [];
    let edges: RoadmapDoc['edges'] = [];
    let layout: RoadmapDoc['layout'];
    let viewport: RoadmapDoc['viewport'];
    let theme: Record<string, any> | undefined;
    try {
        const raw = await fs.promises.readFile(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
        edges = Array.isArray(parsed.edges) ? parsed.edges : [];
        layout = parsed.layout;
        viewport = parsed.viewport;
        theme = parsed.theme;
    } catch {
        throw new Error(`Missing or invalid ${ROADMAP_JSON} in repository`);
    }

    let content = '';
    try {
        content = await fs.promises.readFile(path.join(localDir, README_MD), 'utf-8');
    } catch { /* optional */ }

    return { nodes, edges, layout, viewport, theme, content };
}

async function copyDirAndCleanup(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    const srcEntries = await fs.promises.readdir(src, { withFileTypes: true });
    const srcNames = new Set(srcEntries.map((e) => e.name).filter((name) => name !== '.git'));

    let destEntries: fs.Dirent[] = [];
    try {
        destEntries = await fs.promises.readdir(dest, { withFileTypes: true });
    } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
    }
    const destNames = new Set(destEntries.map((e) => e.name).filter((name) => name !== '.git'));

    for (const destName of destNames) {
        if (!srcNames.has(destName)) {
            const destPath = path.join(dest, destName);
            try {
                const stat = await fs.promises.stat(destPath);
                if (stat.isDirectory()) {
                    await fs.promises.rm(destPath, { recursive: true, force: true });
                } else {
                    await fs.promises.unlink(destPath);
                }
            } catch { /* ignore */ }
        }
    }

    for (const entry of srcEntries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDirAndCleanup(srcPath, destPath);
        } else {
            await fs.promises.copyFile(srcPath, destPath);
        }
    }
}

async function syncRoadmapToGit(domainId: string, docId: number, branch: string): Promise<void> {
    const roadmap = await RoadmapModel.get(domainId, docId);
    if (!roadmap) return;

    const repoGitPath = getRoadmapGitPath(domainId, docId);
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        return;
    }

    try {
        await exec(`git checkout ${branch}`, { cwd: repoGitPath });
    } catch {
        return;
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-roadmap-sync-'));
    try {
        await exportRoadmapToFile(roadmap, tmpDir, branch);
        await copyDirAndCleanup(tmpDir, repoGitPath);
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    }
}

export type RoadmapGitStatus = {
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
    lastCommitShort?: string;
    lastCommitMessage?: string;
    lastCommitMessageShort?: string;
    lastCommitTime?: string;
    changes?: {
        added: string[];
        modified: string[];
        deleted: string[];
    };
};

export async function getRoadmapGitStatus(
    domainId: string,
    docId: number,
    branch: string,
    remoteUrl?: string,
): Promise<RoadmapGitStatus | null> {
    const repoGitPath = getRoadmapGitPath(domainId, docId);
    await ensureGitSafeDirectory(repoGitPath);

    const defaultStatus: RoadmapGitStatus = {
        hasLocalRepo: false,
        hasLocalBranch: false,
        hasRemote: false,
        hasRemoteBranch: false,
        localCommits: 0,
        remoteCommits: 0,
        behind: 0,
        ahead: 0,
        uncommittedChanges: false,
        changes: { added: [], modified: [], deleted: [] },
    };

    try {
        try {
            await exec('git rev-parse --git-dir', { cwd: repoGitPath });
        } catch {
            return defaultStatus;
        }

        try {
            try {
                await exec(`git checkout ${branch}`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec('git checkout main', { cwd: repoGitPath });
                    await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        try {
            await syncRoadmapToGit(domainId, docId, branch);
        } catch (err) {
            console.error('Failed to sync roadmap to git:', err);
        }

        const status: RoadmapGitStatus = { ...defaultStatus, hasLocalRepo: true };

        try {
            const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
            status.currentBranch = currentBranch.trim();
        } catch { /* ignore */ }

        try {
            await exec(`git rev-parse --verify ${branch}`, { cwd: repoGitPath });
            status.hasLocalBranch = true;
            try {
                const { stdout: localCount } = await exec(`git rev-list --count ${branch}`, { cwd: repoGitPath });
                status.localCommits = parseInt(localCount.trim(), 10) || 0;
            } catch { /* ignore */ }
            try {
                const { stdout: lastCommit } = await exec(`git rev-parse ${branch}`, { cwd: repoGitPath });
                const fullCommit = lastCommit.trim();
                status.lastCommit = fullCommit;
                status.lastCommitShort = fullCommit.substring(0, 8);
                try {
                    const { stdout: commitMessage } = await exec(`git log -1 --format=%s ${branch}`, { cwd: repoGitPath });
                    const fullMessage = commitMessage.trim();
                    if (fullMessage) {
                        status.lastCommitMessage = fullMessage;
                        status.lastCommitMessageShort = fullMessage.length > 50 ? fullMessage.substring(0, 50) : fullMessage;
                    }
                } catch { /* ignore */ }
                try {
                    const { stdout: commitTime } = await exec(`git log -1 --pretty=format:"%ci" ${branch}`, { cwd: repoGitPath });
                    status.lastCommitTime = commitTime.trim();
                } catch { /* ignore */ }
            } catch { /* ignore */ }
        } catch {
            status.hasLocalBranch = false;
        }

        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            const changes = statusOutput.trim();
            status.uncommittedChanges = changes.length > 0;
            if (changes && status.changes) {
                for (const line of changes.split('\n').filter((l) => l.trim())) {
                    const code = line.substring(0, 2);
                    const file = line.substring(3).trim();
                    if (code.startsWith('??') || code.startsWith('A')) {
                        status.changes.added.push(file);
                    } else if (code.startsWith('M') || code.startsWith(' M')) {
                        status.changes.modified.push(file);
                    } else if (code.startsWith('D') || code.startsWith(' D')) {
                        status.changes.deleted.push(file);
                    }
                }
            }
        } catch {
            status.uncommittedChanges = false;
        }

        try {
            const { stdout: existingRemote } = await exec('git remote get-url origin', { cwd: repoGitPath });
            if (existingRemote && existingRemote.trim()) {
                status.hasRemote = true;
                if (remoteUrl && remoteUrl.trim() && existingRemote.trim() !== remoteUrl.trim()) {
                    try {
                        await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                    } catch { /* ignore */ }
                }
            }
        } catch {
            if (remoteUrl) {
                try {
                    await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                    status.hasRemote = true;
                } catch { /* ignore */ }
            }
        }

        if (status.hasRemote) {
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
                        status.remoteCommits = parseInt(remoteCount.trim(), 10) || 0;
                    } catch { /* ignore */ }
                    if (status.hasLocalBranch) {
                        try {
                            const { stdout: aheadOutput } = await exec(
                                `git rev-list --left-right --count origin/${branch}...${branch}`,
                                { cwd: repoGitPath },
                            );
                            const parts = aheadOutput.trim().split(/\s+/);
                            if (parts.length >= 2) {
                                status.behind = parseInt(parts[0].trim(), 10) || 0;
                                status.ahead = parseInt(parts[1].trim(), 10) || 0;
                            }
                        } catch { /* ignore */ }
                    }
                } catch {
                    status.hasRemoteBranch = false;
                }
            } catch { /* ignore */ }
        }

        return status;
    } catch (err) {
        console.error('getRoadmapGitStatus error:', err);
        return defaultStatus;
    }
}

export async function commitRoadmapChanges(
    domainId: string,
    docId: number,
    roadmap: RoadmapDoc,
    commitMessage: string,
    userId: number,
    userName: string,
): Promise<void> {
    const repoGitPath = await ensureRoadmapGitRepo(domainId, docId);
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await execFile('git', ['config', 'user.name', String(botName)], { cwd: repoGitPath });
    await execFile('git', ['config', 'user.email', String(botEmail)], { cwd: repoGitPath });

    const branch = (roadmap as any).currentBranch || 'main';
    try {
        await execFile('git', ['checkout', String(branch)], { cwd: repoGitPath });
    } catch {
        try {
            await execFile('git', ['checkout', 'main'], { cwd: repoGitPath });
            await execFile('git', ['checkout', '-b', String(branch)], { cwd: repoGitPath });
        } catch {
            await execFile('git', ['checkout', '-b', String(branch)], { cwd: repoGitPath });
        }
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-roadmap-commit-'));
    try {
        await exportRoadmapToFile(roadmap, tmpDir, branch);
        await copyDirAndCleanup(tmpDir, repoGitPath);
        await execFile('git', ['add', '-A'], { cwd: repoGitPath });
        try {
            const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: repoGitPath });
            if (stdout.trim()) {
                const defaultPrefix = `${domainId}/${userId}/${userName || 'unknown'}`;
                const finalMessage = commitMessage && commitMessage.trim()
                    ? `${defaultPrefix}: ${commitMessage.trim()}`
                    : defaultPrefix;
                await execFile('git', ['commit', '-m', finalMessage], { cwd: repoGitPath });
            }
        } catch (err) {
            console.error('[commitRoadmapChanges] Error during commit:', err);
            throw err;
        }
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    }
}

async function gitInitAndPushRoadmap(
    domainId: string,
    docId: number,
    roadmap: RoadmapDoc,
    remoteUrlWithAuth: string,
    branch: string = 'main',
    commitMessage: string = 'chore: sync roadmap from ejunz',
): Promise<void> {
    const repoGitPath = await ensureRoadmapGitRepo(domainId, docId, remoteUrlWithAuth);
    const gitEnv: Record<string, string> = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
    };
    const execOptions: any = { cwd: repoGitPath, env: gitEnv };
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, execOptions);
    await exec(`git config user.email "${botEmail}"`, execOptions);

    try {
        const { stdout: currentRemote } = await exec('git remote get-url origin', execOptions);
        const currentUrl = String(currentRemote).trim();
        if (currentUrl !== remoteUrlWithAuth) {
            await exec(`git remote set-url origin "${remoteUrlWithAuth}"`, execOptions);
        }
    } catch {
        await exec(`git remote add origin "${remoteUrlWithAuth}"`, execOptions);
    }

    let isNewRepo = false;
    try {
        await exec('git rev-parse HEAD', execOptions);
    } catch {
        isNewRepo = true;
    }

    try {
        await exec(`git checkout ${branch}`, execOptions);
    } catch {
        try {
            await exec(`git checkout -b ${branch}`, execOptions);
        } catch { /* ignore */ }
    }

    if (!isNewRepo) {
        try {
            await exec('git fetch origin', execOptions);
            await exec(`git pull origin ${branch}`, execOptions);
        } catch { /* ignore */ }
    }

    await exportRoadmapToFile(roadmap, repoGitPath, branch);
    await exec('git add -A', execOptions);

    try {
        const { stdout } = await exec('git status --porcelain', execOptions);
        if (String(stdout).trim()) {
            const escapedMessage = commitMessage.replace(/'/g, "'\\''");
            await exec(`git commit -m '${escapedMessage}'`, execOptions);
        }
    } catch {
        const escapedMessage = commitMessage.replace(/'/g, "'\\''");
        try {
            await exec(`git commit -m '${escapedMessage}'`, execOptions);
        } catch { /* ignore */ }
    }

    try {
        await exec(`git push origin ${branch}`, execOptions);
    } catch {
        await exec(`git push -u origin ${branch}`, execOptions);
    }
}

class RoadmapGitStatusHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        const bodyDoc = readOptionalRequestBaseDocId(this.request);
        const id = bodyDoc ?? (docId > 0 ? docId : undefined);
        if (!id) throw new BadRequestError('docId');
        const roadmap = await RoadmapModel.get(domainId, id);
        if (!roadmap) throw new NotFoundError('Roadmap not found');

        const effectiveBranch = (branch || (roadmap as any).currentBranch || 'main').toString();
        const githubRepo = ((roadmap as any).githubRepo || '') as string;
        let gitStatus: RoadmapGitStatus | null = null;
        if (githubRepo) {
            try {
                const repoUrl = await resolveGithubRemoteUrlForRepo(
                    this.ctx,
                    domainId,
                    this.user._id,
                    githubRepo,
                    this.request.body?.githubToken,
                );
                gitStatus = await getRoadmapGitStatus(domainId, roadmap.docId, effectiveBranch, repoUrl);
            } catch (err) {
                console.error('Failed to get roadmap git status:', err);
                gitStatus = await getRoadmapGitStatus(domainId, roadmap.docId, effectiveBranch);
            }
        } else {
            gitStatus = await getRoadmapGitStatus(domainId, roadmap.docId, effectiveBranch);
        }

        this.response.body = { gitStatus, branch: effectiveBranch };
    }
}

class RoadmapCommitHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, branch?: string) {
        const body = this.request.body || {};
        const customMessage = body.commitMessage || body.note || '';
        const bodyDoc = readOptionalRequestBaseDocId(this.request);
        const useDocId = bodyDoc ?? (docId > 0 ? docId : undefined);
        if (!useDocId) throw new BadRequestError('docId');

        const roadmap = await RoadmapModel.get(domainId, useDocId);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const effectiveBranch = (
            (branch && String(branch).trim())
            || (body.branch && String(body.branch).trim())
            || (roadmap as any).currentBranch
            || 'main'
        ).toString();
        const roadmapForCommit = { ...roadmap, currentBranch: effectiveBranch } as RoadmapDoc;

        try {
            await commitRoadmapChanges(
                domainId,
                roadmap.docId,
                roadmapForCommit,
                customMessage,
                this.user._id,
                this.user.uname || 'unknown',
            );
            this.response.body = { ok: true, message: 'Changes committed successfully' };
        } catch (err: any) {
            console.error('Roadmap commit failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, error: err?.message || String(err) };
        }
    }
}

class RoadmapGithubConfigHandler extends Handler {
    roadmap?: RoadmapDoc;

    @param('docId', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: number) {
        this.roadmap = await resolveRoadmapFromRequest(domainId, docId, this.request) || undefined;
        if (!this.roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(this.roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
    }

    @param('docId', Types.PositiveInt, true)
    async get(domainId: string, docId: number) {
        await this._prepare(domainId, docId);
        const r = ((this.roadmap as any).githubRepo || '') as string;
        this.response.body = { githubRepo: r || null };
    }

    @param('docId', Types.PositiveInt, true)
    async post(domainId: string, docId: number) {
        await this._prepare(domainId, docId);
        const fromBody = (this.request.body || {}).githubRepo;
        let outRepo: string | null = ((this.roadmap as any).githubRepo || '') as string || null;
        if (fromBody !== undefined) {
            let repoUrlForStorage = typeof fromBody === 'string' ? fromBody : String(fromBody);
            if (repoUrlForStorage && repoUrlForStorage.startsWith('https://') && repoUrlForStorage.includes('@github.com')) {
                repoUrlForStorage = repoUrlForStorage.replace(/^https:\/\/[^@]+@github\.com\//, 'https://github.com/');
            }
            await document.set(domainId, document.TYPE_ROADMAP, this.roadmap!.docId, {
                githubRepo: repoUrlForStorage || null,
            } as any);
            outRepo = repoUrlForStorage || null;
        }
        this.response.body = { success: true, githubRepo: outRepo };
    }
}

class RoadmapGithubPullHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, branch?: string) {
        const roadmap = await resolveRoadmapFromRequest(domainId, docId, this.request);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const githubRepo = ((roadmap as any).githubRepo || '') as string;
        if (!githubRepo) throw new Error('GitHub repository not configured.');

        const ghTok = await resolveGithubToken(this.ctx, domainId, this.user._id, this.request.body?.githubToken);
        assertGithubPushPullToken(githubRepo, ghTok);
        const repoUrl = buildGithubRemoteUrl(githubRepo, ghTok);
        const effectiveBranch = (branch || (roadmap as any).currentBranch || this.request.body?.branch || 'main').toString();
        const repoGitPath = await ensureRoadmapGitRepo(domainId, roadmap.docId, repoUrl);

        try {
            try {
                await exec(`git checkout ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                await exec(`git checkout -b ${effectiveBranch}`, { cwd: repoGitPath });
            }
            try {
                await exec(`git remote set-url origin ${repoUrl}`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec(`git remote add origin ${repoUrl}`, { cwd: repoGitPath });
                } catch { /* ignore */ }
            }
            await exec('git fetch origin', { cwd: repoGitPath });
            await exec(`git reset --hard origin/${effectiveBranch}`, { cwd: repoGitPath });

            const imported = await importRoadmapFromFile(repoGitPath);
            setBranchData(roadmap as any, effectiveBranch, imported.nodes || [], imported.edges || []);
            RoadmapModel.setBranchMeta(roadmap, effectiveBranch, {
                layout: imported.layout,
                viewport: imported.viewport,
                theme: imported.theme,
            });

            await RoadmapModel.updateFull(domainId, roadmap.docId, {
                branchData: (roadmap as any).branchData,
                nodes: (roadmap as any).nodes,
                edges: (roadmap as any).edges,
                content: imported.content ?? roadmap.content,
                layout: imported.layout,
                viewport: imported.viewport,
                theme: imported.theme,
            });

            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Roadmap pull failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
    }
}

class RoadmapGithubPushHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, branch?: string) {
        const roadmap = await resolveRoadmapFromRequest(domainId, docId, this.request);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const githubRepo = ((roadmap as any).githubRepo || '') as string;
        if (!githubRepo) throw new Error('GitHub repository not configured.');

        const ghTok = await resolveGithubToken(this.ctx, domainId, this.user._id, this.request.body?.githubToken);
        assertGithubPushPullToken(githubRepo, ghTok);
        const repoUrl = buildGithubRemoteUrl(githubRepo, ghTok);
        const effectiveBranch = (branch || (roadmap as any).currentBranch || this.request.body?.branch || 'main').toString();
        const roadmapForPush = { ...roadmap, currentBranch: effectiveBranch } as RoadmapDoc;

        try {
            const commitMessage = this.request.body?.commitMessage
                || `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update roadmap`;
            try {
                await commitRoadmapChanges(
                    domainId,
                    roadmap.docId,
                    roadmapForPush,
                    commitMessage,
                    this.user._id,
                    this.user.uname || 'unknown',
                );
            } catch (err: any) {
                console.warn('Roadmap commit before push failed:', err?.message || err);
            }
            await gitInitAndPushRoadmap(
                domainId,
                roadmap.docId,
                roadmapForPush,
                repoUrl,
                effectiveBranch,
                commitMessage,
            );
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Roadmap push failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
    }
}

class RoadmapBranchCreateHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    async post(domainId: string, docId: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { branch: newBranch, sourceBranch } = this.request.body || {};
        if (!newBranch || !String(newBranch).trim()) {
            throw new BadRequestError('Branch name is required');
        }
        const branchName = String(newBranch).trim();
        if (branchName === 'main') throw new ForbiddenError('Cannot create branch named main');

        const bodyDoc = readOptionalRequestBaseDocId(this.request);
        const useDocId = bodyDoc ?? docId;
        const roadmap = await RoadmapModel.get(domainId, useDocId);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const source = sourceBranch?.trim() || 'main';
        const branches: string[] = Array.isArray((roadmap as any).branches) ? [...(roadmap as any).branches] : ['main'];
        if (branches.includes(branchName)) throw new BadRequestError('Branch already exists');
        branches.push(branchName);

        const srcData = getBranchData(roadmap as any, source);
        setBranchData(roadmap as any, branchName,
            JSON.parse(JSON.stringify(srcData.nodes)),
            JSON.parse(JSON.stringify(srcData.edges)),
        );
        const srcMeta = RoadmapModel.getBranchMeta(roadmap, source);
        RoadmapModel.setBranchMeta(roadmap, branchName, { ...srcMeta });

        await document.set(domainId, document.TYPE_ROADMAP, roadmap.docId, {
            branches,
            branchData: (roadmap as any).branchData,
            roadmapBranchMeta: (roadmap as any).roadmapBranchMeta,
        } as any);

        try {
            const repoGitPath = await ensureRoadmapGitRepo(domainId, roadmap.docId);
            try {
                await exec('git checkout main', { cwd: repoGitPath });
            } catch {
                try {
                    await exec('git checkout -b main', { cwd: repoGitPath });
                } catch { /* ignore */ }
            }
            await exec('git checkout main', { cwd: repoGitPath });
            await exec(`git checkout -b ${branchName}`, { cwd: repoGitPath });
        } catch (err) {
            console.error('Failed to create roadmap git branch:', err);
        }

        this.response.body = { success: true, branch: branchName };
    }
}

class RoadmapBranchesHandler extends Handler {
    @param('docId', Types.PositiveInt)
    async get(domainId: string, docId: number) {
        const roadmap = await RoadmapModel.get(domainId, docId);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        const branches = collectRoadmapBranches(roadmap);
        const currentBranch = (roadmap as any).currentBranch || 'main';
        this.response.body = { branches, currentBranch };
    }
}

export async function applyRoadmapGitRoutes(ctx: Context) {
    ctx.Route('roadmap_git_status', '/roadmap/git/status', RoadmapGitStatusHandler);
    ctx.Route('roadmap_github_config', '/roadmap/github/config', RoadmapGithubConfigHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_commit_branch', '/roadmap/branch/:branch/commit', RoadmapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_github_pull_branch', '/roadmap/branch/:branch/github/pull', RoadmapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_github_push_branch', '/roadmap/branch/:branch/github/push', RoadmapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_branch_create', '/roadmap/branch', RoadmapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_branches', '/roadmap/:docId/branches', RoadmapBranchesHandler);
}

export async function fetchRoadmapGithubContext(domainId: string, uid: number): Promise<{
    userGithubTokenConfigured: boolean;
}> {
    const userTok = await fetchUserGithubToken(domainId, uid);
    return { userGithubTokenConfigured: !!userTok };
}
