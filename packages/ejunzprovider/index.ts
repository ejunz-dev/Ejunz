import { Context, Logger, RepoModel } from 'ejun';
import { apply as applyTimeMcp } from './src/mcp/time';
import { apply as applyLogsHandler } from './src/handler/logs';
import { apply as applyWebSocketHandler } from './src/handler/websocket';
import { addLog } from './src/handler/logs';
import { escapeRegExp } from 'lodash';

interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
        required?: string[];
    };
}

function getAvailableTools(): McpTool[] {
	return [
		{
			name: 'hltv_news',
			description: '获取 HLTV 新闻列表（CS 资讯）',
			inputSchema: {
				type: 'object',
				properties: {
					timeoutMs: { type: 'number', description: '请求超时毫秒数，默认 8000' },
					retries: { type: 'number', description: '失败重试次数，默认 1' },
				},
			},
		},
		{
			name: 'hltv_matches',
			description: '获取 HLTV 比赛赛程列表',
			inputSchema: {
				type: 'object',
				properties: {
					timeoutMs: { type: 'number', description: '请求超时毫秒数，默认 8000' },
					retries: { type: 'number', description: '失败重试次数，默认 1' },
				},
			},
		},
		{
			name: 'hltv_results',
			description: '获取 HLTV 比赛结果列表',
			inputSchema: {
				type: 'object',
				properties: {
					timeoutMs: { type: 'number', description: '请求超时毫秒数，默认 8000' },
					retries: { type: 'number', description: '失败重试次数，默认 1' },
				},
			},
		},
		{
			name: 'search_repo',
			description: '搜索知识库（repo），根据关键词查找相关的知识库条目。可以搜索标题、内容、标签或ID。当用户询问知识库相关内容时使用此工具。',
			inputSchema: {
				type: 'object',
				properties: {
					query: { 
						type: 'string', 
						description: '搜索关键词，可以是标题、内容、标签或知识库ID（如R1、R2等）' 
					},
					domainId: { 
						type: 'string', 
						description: '域名ID，默认为"system"。如果用户没有指定，使用默认值' 
					},
					limit: { 
						type: 'number', 
						description: '返回结果数量限制，默认10，最大50' 
					},
				},
				required: ['query'],
			},
		},
	];
}

async function callTool(name: string, args: any): Promise<any> {
    const fetchJson = async (url: string, opts?: { timeoutMs?: number, retries?: number }) => {
		const timeoutMs = Math.max(1, Number(opts?.timeoutMs) || 8000);
		const retries = Math.max(0, Number(opts?.retries) || 1);
		const controller = new AbortController();
		const attempt = async (n: number): Promise<any> => {
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				let init: any = { signal: controller.signal, headers: { 'accept': 'application/json' } };
				const proxyEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
					|| process.env.https_proxy || process.env.http_proxy || process.env.all_proxy;
				if (proxyEnv) {
					try {
						const undici = await import('undici');
						const proxy = proxyEnv;
						// @ts-ignore
						const agent = new (undici as any).ProxyAgent(proxy);
						init.dispatcher = agent;
					} catch { /* ignore proxy agent errors */ }
				}
				const res = await fetch(url, init as any);
				if (!res.ok) throw new Error(`请求失败: ${res.status}`);
				return await res.json();
			} catch (e) {
				if (n < retries) return attempt(n + 1);
				throw e;
			} finally {
				clearTimeout(timer);
			}
		};
		return attempt(0);
	};

	switch (name) {
		case 'hltv_news': {
			const url = 'https://hltv-api.vercel.app/api/news.json';
			return await fetchJson(url, { timeoutMs: args?.timeoutMs, retries: args?.retries });
		}

		case 'hltv_matches': {
			const url = 'https://hltv-api.vercel.app/api/matches.json';
			return await fetchJson(url, { timeoutMs: args?.timeoutMs, retries: args?.retries });
		}

		case 'hltv_results': {
			const url = 'https://hltv-api.vercel.app/api/results.json';
			return await fetchJson(url, { timeoutMs: args?.timeoutMs, retries: args?.retries });
		}

		case 'search_repo': {
			const query = args?.query;
			if (!query || typeof query !== 'string') {
				throw new Error('搜索关键词不能为空');
			}
			const domainId = args?.domainId || 'system';
			const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
			
			// 执行搜索
			const escaped = escapeRegExp(query.toLowerCase());
			const $regex = new RegExp(query.length >= 2 ? escaped : `\\A${escaped}`, 'gmi');
			const filter: any = { $or: [{ rid: { $regex } }, { title: { $regex } }, { tag: query }] };
			
			const rdocs = await RepoModel.getMulti(domainId, filter, ['domainId', 'docId', 'rid', 'title', 'content', 'tag', 'updateAt'])
				.limit(limit)
				.toArray();
			
			// 如果搜索不到，尝试精确匹配
			if (rdocs.length === 0) {
				let rdoc = await RepoModel.get(domainId, Number.isSafeInteger(+query) ? +query : query, ['domainId', 'docId', 'rid', 'title', 'content', 'tag', 'updateAt']);
				if (rdoc) rdocs.push(rdoc);
				else if (/^R\d+$/.test(query)) {
					rdoc = await RepoModel.get(domainId, +query.substring(1), ['domainId', 'docId', 'rid', 'title', 'content', 'tag', 'updateAt']);
					if (rdoc) rdocs.push(rdoc);
				}
			}
			
			// 格式化返回结果
			return {
				query,
				domainId,
				total: rdocs.length,
				results: rdocs.map((rdoc: any) => ({
					rid: rdoc.rid,
					title: rdoc.title,
					content: rdoc.content?.substring(0, 500) + (rdoc.content && rdoc.content.length > 500 ? '...' : ''), // 限制内容长度
					tags: rdoc.tag || [],
					updateAt: rdoc.updateAt,
					docId: rdoc.docId,
					url: `/d/${domainId}/repo/${rdoc.rid}`,
				})),
			};
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

export async function apply(ctx: Context) {
    const logger = ctx.logger('ejunzprovider');
    
    await applyTimeMcp(ctx);
    await applyLogsHandler(ctx);
    await applyWebSocketHandler(ctx);
    
    const tools = getAvailableTools();
    logger.info('Registering MCP tools:', { count: tools.length, names: tools.map(t => t.name) });
    
    ctx.on('mcp/tools/list' as any, () => {
        logger.info('Requesting tool list', { toolCount: tools.length });
        return tools;
    });
    ctx.on('mcp/tools/list/local' as any, () => {
		logger.info('Requesting local tool list', { toolCount: tools.length });
		return tools;
	});
    
    ctx.on('mcp/tool/call' as any, async (data: any) => {
		logger.info(`Tool call: ${data.name}`, data.args);
		addLog('info', `Tool call: ${data.name}, args: ${JSON.stringify(data.args)}`);
		
		try {
			const result = await callTool(data.name, data.args);
			
			logger.info(`Tool ${data.name} returned:`, result);
			addLog('info', `Tool ${data.name} returned: ${JSON.stringify(result)}`);
			
			return result;
		} catch (error: any) {
			logger.error(`Tool call failed: ${data.name}`, error.message);
			addLog('error', `Tool call failed: ${data.name}, error: ${error.message}`);
			throw error;
		}
	});
    ctx.on('mcp/tool/call/local' as any, async (data: any) => {
		logger.info(`Local tool call: ${data.name}`, data.args);
		addLog('info', `Local tool call: ${data.name}, args: ${JSON.stringify(data.args)}`);
		try {
			const result = await callTool(data.name, data.args);
			logger.info(`Local tool ${data.name} returned:`, result);
			addLog('info', `Local tool ${data.name} returned: ${JSON.stringify(result)}`);
			return result;
		} catch (error: any) {
			logger.error(`Local tool call failed: ${data.name}`, error.message);
			addLog('error', `Local tool call failed: ${data.name}, error: ${error.message}`);
			throw error;
		}
	});
    
    addLog('info', 'MCP Provider initialized');
    logger.info('MCP Provider initialized');
}

