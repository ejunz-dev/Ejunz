import { Context, Logger } from 'ejun';

const logger = new Logger('mcp-time');

export async function startMcpServer() {
    const mcpServer = await import('@modelcontextprotocol/sdk/server/index.js');
    const mcpStdio = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const mcpTypes = await import('@modelcontextprotocol/sdk/types.js');
    
    const { Server } = mcpServer;
    const { StdioServerTransport } = mcpStdio;
    const { ListToolsRequestSchema, CallToolRequestSchema } = mcpTypes;

    const server = new Server(
        {
            name: 'ejunz-time',
            version: '0.1.0',
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'hltv_news',
                description: '获取 HLTV 新闻列表（CS 资讯）',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'hltv_matches',
                description: '获取 HLTV 比赛赛程列表',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'hltv_results',
                description: '获取 HLTV 比赛结果列表',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name } = request.params;

        const fetchJson = async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`请求失败: ${res.status}`);
            return await res.json();
        };

        switch (name) {
            case 'hltv_news': {
                const data = await fetchJson('https://hltv-api.vercel.app/api/news.json');
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(data, null, 2),
                        },
                    ],
                };
            }
            case 'hltv_matches': {
                const data = await fetchJson('https://hltv-api.vercel.app/api/matches.json');
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(data, null, 2),
                        },
                    ],
                };
            }
            case 'hltv_results': {
                const data = await fetchJson('https://hltv-api.vercel.app/api/results.json');
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(data, null, 2),
                        },
                    ],
                };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });

    const transport = new StdioServerTransport();
    
    try {
        await server.connect(transport);
        logger.info('MCP Time Server started on stdio');
    } catch (error: any) {
        logger.error(`Failed to start MCP server: ${error.message}`);
        throw error;
    }

    return server;
}

export async function apply(ctx: Context) {
    logger.info('Time MCP service module loaded');
}

if (require.main === module) {
    startMcpServer().catch(error => {
        console.error('Failed to start MCP server:', error);
        process.exit(1);
    });
}
