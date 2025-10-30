import { Context, Logger } from 'ejun';
import { apply as applyTimeMcp } from './src/mcp/time';
import { apply as applyLogsHandler } from './src/handler/logs';
import { apply as applyWebSocketHandler } from './src/handler/websocket';
import { addLog } from './src/handler/logs';

interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
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

