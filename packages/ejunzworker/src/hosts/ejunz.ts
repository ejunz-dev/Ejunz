import PQueue from 'p-queue';
import superagent from 'superagent';
import WebSocket from 'ws';
import type { LangConfig } from '@ejunz/common';
import { getConfig } from '../config';
import { SystemError } from '../error';
import { Session } from '../interface';
import log from '../log';
import { ToolCallTaskHandler } from '../toolcall';

export default class Ejunz implements Session {
    toolcallWs?: WebSocket;
    language: Record<string, LangConfig> = {};

    constructor(public config) {
        this.config.detail ??= true;
        this.config.cookie ||= '';
        this.config.last_update_at ||= 0;
        if (!this.config.server_url.startsWith('http')) this.config.server_url = `http://${this.config.server_url}`;
        if (!this.config.server_url.endsWith('/')) this.config.server_url = `${this.config.server_url}/`;
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

    async fetchFile<T extends string | null>(namespace: T, files: Record<string, string>): Promise<T extends null ? string : null> {
        throw new SystemError('fetchFile not supported (worker service removed)');
    }

    async postFile(target: string, filename: string, file: string, retry = 3) {
        throw new SystemError('postFile not supported (worker service removed)');
    }

    getLang(name: string, doThrow = true) {
        if (this.language[name]) return this.language[name];
        if (name === 'cpp' && this.language.cc) return this.language.cc;
        if (doThrow) throw new SystemError('Unsupported language {0}', [name]);
        return null;
    }

    getReporter(t: any) {
        return {
            next: () => {},
            end: () => {},
        };
    }

    async consumeToolCall(queue: PQueue) {
        log.info(`[${this.config.host}] 开始从数据库轮询工具调用任务`);
        
        try {
            const { TaskModel } = require('ejun');
            const toolCallHandler = new ToolCallTaskHandler(this.config.server_url, this.config.cookie);
            
            const query: any = { type: 'tool_call' };
            if (this.config.minPriority !== undefined) {
                query.priority = { $gt: this.config.minPriority };
            }
            
            const concurrency = this.config.toolcallConcurrency || 10;
            
            const handleTask = async (t: any) => {
                const taskId = t._id?.toString() || t._id;
                log.info(`[${this.config.host}] 处理工具调用任务: ${t.toolName} (${taskId})`);
                
                const sendNext = async (data: any) => {
                    log.debug(`[${this.config.host}] Tool call progress: ${t.toolName}`, data);
                };
                
                const sendEnd = async (data: any) => {
                    log.info(`[${this.config.host}] Tool call completed: ${t.toolName}`, data);
                    try {
                        const { bus } = require('ejun');
                        if (bus) {
                            bus.broadcast('toolcall/complete', t._id, data?.result || data?.error || data);
                        }
                    } catch (e) {
                        log.debug(`[${this.config.host}] 无法访问事件总线，忽略`);
                    }
                };
                
                await toolCallHandler.handle(t, sendNext, sendEnd);
            };
            
            const consumer = TaskModel.consume(query, handleTask, true, concurrency);
            
            log.info(`[${this.config.host}] 工具调用任务消费者已启动 (并发数: ${concurrency})`);
            
            (this as any).toolCallConsumer = consumer;
        } catch (error) {
            log.error(`[${this.config.host}] 无法从数据库轮询任务，错误:`, error);
            log.warn(`[${this.config.host}] 如果 worker 无法访问主服务器数据库，请确保配置了数据库连接`);
            throw error;
        }
    }

    dispose() {
        this.toolcallWs?.close?.();
        if ((this as any).toolCallConsumer) {
            (this as any).toolCallConsumer.destroy();
        }
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
            await this.get('').set('Accept', 'application/json');
        } catch (e) {
            await this.login();
        }
    }
}
