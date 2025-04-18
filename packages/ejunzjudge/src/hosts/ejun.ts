/* eslint-disable no-await-in-loop */
import path from 'path';
import PQueue from 'p-queue';
import superagent from 'superagent';
import WebSocket from 'ws';
import { fs, pipeRequest } from '@ejunz/utils';
import { LangConfig } from '@ejunz/utils/lib/lang';
import * as sysinfo from '@ejunz/utils/lib/sysinfo';
import type { JudgeResultBody } from 'ejun';
import { compilerVersions } from '../compiler';
import { getConfig } from '../config';
import { FormatError, SystemError } from '../error';
import { Session } from '../interface';
import log from '../log';
import { JudgeTask } from '../task';
import { Lock } from '../utils';

function removeNixPath(text: string) {
    return text.replace(/\/nix\/store\/[a-z0-9]{32}-/g, '/nix/');
}

export default class Ejunz implements Session {
    ws: WebSocket;
    language: Record<string, LangConfig>;

    constructor(public config) {
        this.config.detail ??= true;
        this.config.cookie ||= '';
        this.config.last_update_at ||= 0;
        if (!this.config.server_url.startsWith('http')) this.config.server_url = `http://${this.config.server_url}`;
        if (!this.config.server_url.endsWith('/')) this.config.server_url = `${this.config.server_url}/`;
        this.getLang = this.getLang.bind(this);
    }

    get(url: string) {
        url = new URL(url, this.config.server_url).toString();
        return superagent.get(url).set('Cookie', this.config.cookie);
    }

    post(url: string, data?: any) {
        url = new URL(url, this.config.server_url).toString();
        const t = superagent.post(url)
            .set('Cookie', this.config.cookie)
            .set('Accept', 'application/json');
        return data ? t.send(data) : t;
    }

    async init() {
        await this.setCookie(this.config.cookie || '');
        await this.ensureLogin();
        setInterval(() => { this.get(''); }, 30000000); // Cookie refresh only
    }

    async cacheOpen(source: string, files: any[], next?) {
        await Lock.acquire(`${this.config.host}/${source}`);
        try {
            return await this._cacheOpen(source, files, next);
        } catch (e) {
            log.warn('CacheOpen Fail: %s %o %o', source, files, e);
            throw e;
        } finally {
            Lock.release(`${this.config.host}/${source}`);
        }
    }

    async _cacheOpen(source: string, files: any[], next?) {
        const [domainId, pid] = source.split('/');
        const filePath = path.join(getConfig('cache_dir'), this.config.host, source);
        await fs.ensureDir(filePath);
        if (!files?.length) throw new FormatError('Problem data not found.');
        let etags: Record<string, string> = {};
        try {
            etags = JSON.parse(await fs.readFile(path.join(filePath, 'etags'), 'utf-8'));
        } catch (e) { /* ignore */ }
        const version = {};
        const filenames = [];
        const allFiles = new Set<string>();
        for (const file of files) {
            allFiles.add(file.name);
            version[file.name] = file.etag + file.lastModified;
            if (etags[file.name] !== file.etag + file.lastModified) filenames.push(file.name);
        }
        for (const name in etags) {
            if (!allFiles.has(name) && fs.existsSync(path.join(filePath, name))) await fs.remove(path.join(filePath, name));
        }
        if (filenames.length) {
            log.info(`Getting problem data: ${this.config.host}/${source}`);
            next?.({ message: 'Syncing testdata, please wait...' });
            await this.ensureLogin();
            const res = await this.post(`/d/${domainId}/judge/files`, {
                pid: +pid,
                files: filenames,
            });
            if (!res.body.links) throw new FormatError('problem not exist');
            const tasks = [];
            const queue = new PQueue({ concurrency: 10 });
            for (const name in res.body.links) {
                tasks.push(queue.add(async () => {
                    if (name.includes('/')) await fs.ensureDir(path.join(filePath, name.split('/')[0]));
                    const w = fs.createWriteStream(path.join(filePath, name));
                    await pipeRequest(this.get(res.body.links[name]), w, 60000, name);
                }));
            }
            await Promise.all(tasks);
            await fs.writeFile(path.join(filePath, 'etags'), JSON.stringify(version));
        }
        await fs.writeFile(path.join(filePath, 'lastUsage'), new Date().getTime().toString());
        return filePath;
    }

    async fetchFile(name: string) {
        name = name.split('#')[0];
        const res = await this.post('judge/files', { id: name });
        const target = path.join(getConfig('tmp_dir'), name.replace(/\//g, '_'));
        await pipeRequest(this.get(res.body.url), fs.createWriteStream(target), 60000, name);
        return target;
    }

    async postFile(target: string, filename: string, file: string) {
        await this.post('judge/upload')
            .field('rid', target)
            .field('name', filename)
            .attach('file', fs.createReadStream(file));
    }

    getLang(name: string, doThrow = true) {
        if (this.language[name]) return this.language[name];
        if (name === 'cpp' && this.language.cc) return this.language.cc;
        if (doThrow) throw new SystemError('Unsupported language {0}', [name]);
        return null;
    }

    send(rid: string, key: 'next' | 'end', data: Partial<JudgeResultBody>) {
        if (data.case && typeof data.case.message === 'string') data.case.message = removeNixPath(data.case.message);
        if (typeof data.message === 'string') data.message = removeNixPath(data.message);
        if (typeof data.compilerText === 'string') data.compilerText = removeNixPath(data.compilerText);
        this.ws.send(JSON.stringify({ ...data, rid, key }));
    }

    getNext(t: JudgeTask) {
        return (data: Partial<JudgeResultBody>) => {
            log.debug('Next: %o', data);
            const performanceMode = getConfig('performance') || t.meta.rejudge || t.meta.hackRejudge;
            if (performanceMode && data.case && !data.compilerText && !data.message) {
                t.callbackCache ||= [];
                t.callbackCache.push(data.case);
                // TODO use rate-limited send
                // FIXME handle fields like score, time, memory, etc
            } else {
                this.send(t.request.rid, 'next', data);
            }
        };
    }

    getEnd(t: JudgeTask) {
        return (data: Partial<JudgeResultBody>) => {
            log.info('End: %o', data);
            if (t.callbackCache) data.cases = t.callbackCache;
            this.send(t.request.rid, 'end', data);
        };
    }

    async consume(queue: PQueue) {
        log.info('正在连接 %sjudge/conn', this.config.server_url);
        this.ws = new WebSocket(`${this.config.server_url.replace(/^http/i, 'ws')}judge/conn`, {
            headers: {
                Authorization: `Bearer ${this.config.cookie.split('sid=')[1].split(';')[0]}`,
            },
        });
        const config: { prio?: number, concurrency?: number, lang?: string[] } = {};
        if (this.config.minPriority !== undefined) config.prio = this.config.minPriority;
        if (this.config.concurrency !== undefined) config.concurrency = this.config.concurrency;
        if (this.config.lang?.length) config.lang = this.config.lang;
        const content = Object.keys(config).length
            ? JSON.stringify({ key: 'config', ...config })
            : '{"key":"ping"}';
        let compilers = {};
        let compilerVersionCallback = () => { };
        this.ws.on('message', (data) => {
            if (data.toString() === 'ping') {
                this.ws.send('pong');
                return;
            }
            const request = JSON.parse(data.toString());
            if (request.language) {
                this.language = request.language;
                compilerVersions(this.language).then((res) => {
                    compilers = res;
                    compilerVersionCallback();
                });
            }
            if (request.task) queue.add(() => new JudgeTask(this, request.task).handle().catch((e) => log.error(e)));
        });
        this.ws.on('close', (data, reason) => {
            log.warn(`[${this.config.host}] Websocket 断开:`, data, reason.toString());
            setTimeout(() => this.retry(queue), 30000);
        });
        this.ws.on('error', (e) => {
            log.error(`[${this.config.host}] Websocket 错误:`, e);
            setTimeout(() => this.retry(queue), 30000);
        });
        await new Promise((resolve) => {
            this.ws.once('open', async () => {
                this.ws.send(content);
                this.ws.send('{"key":"start"}');
                if (!this.config.noStatus) {
                    const info = await sysinfo.get();
                    this.ws.send(JSON.stringify({ key: 'status', info: { ...info } }));
                    compilerVersionCallback = () => {
                        this.ws.send(JSON.stringify({ key: 'status', info: { ...info, compilers } }));
                    };
                    setInterval(async () => {
                        const [mid, inf] = await sysinfo.update();
                        this.ws.send(JSON.stringify({ key: 'status', info: { mid, ...inf, compilers } }));
                    }, 1200000);
                }
                resolve(null);
            });
        });
        log.info(`[${this.config.host}] 已连接`);
    }

    dispose() {
        this.ws?.close?.();
    }

    async setCookie(cookie: string) {
        this.config.cookie = cookie;
    }

    async login() {
        log.info('[%s] Updating session', this.config.host);
        const res = await this.post('login', {
            uname: this.config.uname, password: this.config.password, rememberme: 'on',
        });
        const setCookie = res.headers['set-cookie'];
        await this.setCookie(Array.isArray(setCookie) ? setCookie.join(';') : setCookie);
    }

    async ensureLogin() {
        try {
            const res = await this.get('judge/files').set('Accept', 'application/json');
            // Redirected to /login
            if (res.body.url) await this.login();
        } catch (e) {
            await this.login();
        }
    }

    async retry(queue: PQueue) {
        this.consume(queue).catch(() => {
            setTimeout(() => this.retry(queue), 30000);
        });
    }
}
