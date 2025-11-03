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
			description: 'Search the knowledge base (repo) to find relevant entries by keyword. Use this tool when the user asks about knowledge base content, documentation, stored information, or wants to look up specific topics. The tool searches through titles, content, tags, and IDs. Always use this tool proactively when the user\'s question might be answered by information in the knowledge base.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { 
						type: 'string', 
						description: 'Search keywords. Can be a title, content keyword, tag, or repo ID (e.g., R1, R2). Extract the most relevant search terms from the user\'s question.' 
					},
					domainId: { 
						type: 'string', 
						description: 'Domain ID, defaults to "system". Use default if user doesn\'t specify.' 
					},
					limit: { 
						type: 'number', 
						description: 'Maximum number of results to return, default 10, maximum 50' 
					},
				},
				required: ['query'],
			},
		},
		{
			name: 'create_repo',
			description: 'Create a new knowledge base entry (repo). Use this when the user wants to create or add new information to the knowledge base. Always returns the repo link after creation.',
			inputSchema: {
				type: 'object',
				properties: {
					title: {
						type: 'string',
						description: 'Title of the knowledge base entry'
					},
					content: {
						type: 'string',
						description: 'Content of the knowledge base entry (supports markdown)'
					},
					tags: {
						type: 'array',
						items: { type: 'string' },
						description: 'Tags for categorizing the entry'
					},
					domainId: {
						type: 'string',
						description: 'Domain ID, defaults to "system"'
					},
					ownerId: {
						type: 'number',
						description: 'Owner user ID. If not provided, will use a default system user ID (1)'
					},
				},
				required: ['title', 'content'],
			},
		},
		{
			name: 'update_repo',
			description: 'Update an existing knowledge base entry (repo). Use this when the user wants to modify, edit, or update existing knowledge base content. Always returns the repo link after update.',
			inputSchema: {
				type: 'object',
				properties: {
					rid: {
						type: 'string',
						description: 'Repo ID (e.g., R1, R2) or docId to identify the repo to update'
					},
					title: {
						type: 'string',
						description: 'New title (optional, only if updating title)'
					},
					content: {
						type: 'string',
						description: 'New content (optional, only if updating content)'
					},
					tags: {
						type: 'array',
						items: { type: 'string' },
						description: 'New tags (optional, only if updating tags)'
					},
					domainId: {
						type: 'string',
						description: 'Domain ID, defaults to "system"'
					},
				},
				required: ['rid'],
			},
		},
		{
			name: 'get_repo',
			description: 'Get detailed information about a specific knowledge base entry (repo) by its ID. Always returns the repo link.',
			inputSchema: {
				type: 'object',
				properties: {
					rid: {
						type: 'string',
						description: 'Repo ID (e.g., R1, R2) or docId to identify the repo'
					},
					domainId: {
						type: 'string',
						description: 'Domain ID, defaults to "system"'
					},
				},
				required: ['rid'],
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
				throw new Error('Search query cannot be empty');
			}
			const domainId = args?.domainId || 'system';
			const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
			
			// 使用与repo handler相同的搜索逻辑
			const escaped = escapeRegExp(query.toLowerCase());
			const $regex = new RegExp(query.length >= 2 ? escaped : `\\A${escaped}`, 'gmi');
			const filter: any = { $or: [{ rid: { $regex } }, { title: { $regex } }, { tag: query }] };
			
			let rdocs = await RepoModel.getMulti(domainId, filter, RepoModel.PROJECTION_DETAIL)
				.limit(limit)
				.toArray();
			
			// 如果搜索不到，尝试精确匹配（与repo handler逻辑一致）
			if (rdocs.length === 0) {
				let rdoc = await RepoModel.get(domainId, Number.isSafeInteger(+query) ? +query : query, RepoModel.PROJECTION_DETAIL);
				if (rdoc) rdocs.push(rdoc);
				else if (/^R\d+$/.test(query)) {
					rdoc = await RepoModel.get(domainId, +query.substring(1), RepoModel.PROJECTION_DETAIL);
					if (rdoc) rdocs.push(rdoc);
				}
			}
			
			// 格式化返回结果，确保包含链接
			return {
				query,
				domainId,
				total: rdocs.length,
				message: rdocs.length === 0 
					? `No results found for "${query}" in knowledge base` 
					: `Found ${rdocs.length} result(s) for "${query}"`,
				results: rdocs.map((rdoc: any) => ({
					rid: rdoc.rid,
					title: rdoc.title,
					content: rdoc.content?.substring(0, 1000) + (rdoc.content && rdoc.content.length > 1000 ? '...' : ''),
					tags: rdoc.tag || [],
					updateAt: rdoc.updateAt ? new Date(rdoc.updateAt).toISOString() : null,
					docId: rdoc.docId,
					domainId: rdoc.domainId,
					url: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
					link: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
				})),
			};
		}

		case 'create_repo': {
			const title = args?.title;
			const content = args?.content;
			if (!title || typeof title !== 'string') {
				throw new Error('Title is required');
			}
			if (!content || typeof content !== 'string') {
				throw new Error('Content is required');
			}
			const domainId = args?.domainId || 'system';
			const tags = Array.isArray(args?.tags) ? args.tags : [];
			const ownerId = args?.ownerId || 1; // 默认使用系统用户ID 1

			// 创建repo
			const rid = await RepoModel.add(domainId, ownerId, title, content, undefined, false, false, tags);
			
			// 获取创建的repo信息
			const rdoc = await RepoModel.get(domainId, rid, RepoModel.PROJECTION_DETAIL);
			if (!rdoc) {
				throw new Error('Failed to retrieve created repo');
			}

			return {
				success: true,
				message: `Successfully created knowledge base entry "${title}"`,
				repo: {
					rid: rdoc.rid,
					docId: rdoc.docId,
					title: rdoc.title,
					content: rdoc.content?.substring(0, 500) + (rdoc.content && rdoc.content.length > 500 ? '...' : ''),
					tags: rdoc.tag || [],
					domainId: rdoc.domainId,
					url: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
					link: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
				},
			};
		}

		case 'update_repo': {
			const rid = args?.rid;
			if (!rid || typeof rid !== 'string') {
				throw new Error('Repo ID (rid) is required');
			}
			const domainId = args?.domainId || 'system';

			// 获取现有repo
			const existingRepo = await RepoModel.get(domainId, rid, RepoModel.PROJECTION_DETAIL);
			if (!existingRepo) {
				throw new Error(`Repo with ID "${rid}" not found`);
			}

			// 构建更新内容
			const updates: any = {};
			if (args?.title && typeof args.title === 'string') {
				updates.title = args.title;
			}
			if (args?.content && typeof args.content === 'string') {
				updates.content = args.content;
			}
			if (args?.tags && Array.isArray(args.tags)) {
				updates.tag = args.tags;
			}
			
			// 添加更新时间
			updates.updateAt = new Date();

			if (Object.keys(updates).length === 0) {
				throw new Error('No updates provided. Please provide title, content, or tags to update.');
			}

			// 更新repo
			await RepoModel.edit(domainId, rid, updates);

			// 重新获取更新后的repo以确保获取完整信息
			const updatedRepo = await RepoModel.get(domainId, rid, RepoModel.PROJECTION_DETAIL);
			if (!updatedRepo) {
				throw new Error('Failed to retrieve updated repo');
			}

			return {
				success: true,
				message: `Successfully updated knowledge base entry "${updatedRepo.title || rid}"`,
				repo: {
					rid: updatedRepo.rid,
					docId: updatedRepo.docId,
					title: updatedRepo.title,
					content: updatedRepo.content?.substring(0, 500) + (updatedRepo.content && updatedRepo.content.length > 500 ? '...' : ''),
					tags: updatedRepo.tag || [],
					domainId: updatedRepo.domainId,
					updateAt: updatedRepo.updateAt ? new Date(updatedRepo.updateAt).toISOString() : null,
					url: `/d/${updatedRepo.domainId}/repo/${updatedRepo.rid}`,
					link: `/d/${updatedRepo.domainId}/repo/${updatedRepo.rid}`,
				},
			};
		}

		case 'get_repo': {
			const rid = args?.rid;
			if (!rid || typeof rid !== 'string') {
				throw new Error('Repo ID (rid) is required');
			}
			const domainId = args?.domainId || 'system';

			// 获取repo
			const rdoc = await RepoModel.get(domainId, rid, RepoModel.PROJECTION_DETAIL);
			if (!rdoc) {
				throw new Error(`Repo with ID "${rid}" not found`);
			}

			return {
				success: true,
				repo: {
					rid: rdoc.rid,
					docId: rdoc.docId,
					title: rdoc.title,
					content: rdoc.content,
					tags: rdoc.tag || [],
					domainId: rdoc.domainId,
					updateAt: rdoc.updateAt ? new Date(rdoc.updateAt).toISOString() : null,
					views: rdoc.views || 0,
					url: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
					link: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
				},
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

