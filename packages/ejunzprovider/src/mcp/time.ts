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
                name: 'get_current_time',
                description: '获取当前时间',
                inputSchema: {
                    type: 'object',
                    properties: {
                        timezone: {
                            type: 'string',
                            description: '时区，例如：Asia/Shanghai, America/New_York',
                        },
                        format: {
                            type: 'string',
                            description: '时间格式：ISO（默认）、locale 或 custom',
                            enum: ['ISO', 'locale', 'custom'],
                        },
                    },
                },
            },
            {
                name: 'get_time_info',
                description: '获取详细的时间信息',
                inputSchema: {
                    type: 'object',
                    properties: {
                        timezone: {
                            type: 'string',
                            description: '时区，例如：Asia/Shanghai',
                        },
                    },
                },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        switch (name) {
            case 'get_current_time': {
                const timezone = args?.timezone || 'Asia/Shanghai';
                const format = args?.format || 'ISO';
                const now = new Date();
                let formattedTime: string;

                switch (format) {
                    case 'ISO':
                        formattedTime = now.toISOString();
                        break;
                    case 'locale':
                        formattedTime = now.toLocaleString('zh-CN', { timeZone: timezone } as Intl.DateTimeFormatOptions);
                        break;
                    case 'custom':
                        formattedTime = now.toLocaleString('zh-CN', {
                            timeZone: timezone,
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                        } as Intl.DateTimeFormatOptions);
                        break;
                    default:
                        formattedTime = now.toISOString();
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                timestamp: now.getTime(),
                                iso: now.toISOString(),
                                formatted: formattedTime,
                                timezone,
                            }, null, 2),
                        },
                    ],
                };
            }

            case 'get_time_info': {
                const timezone = args?.timezone || 'Asia/Shanghai';
                const now = new Date();
                
                const formatter = new Intl.DateTimeFormat('zh-CN', {
                    timeZone: timezone,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    weekday: 'long',
                } as any);

                const parts: Record<string, string> = {};
                formatter.formatToParts(now).forEach(part => {
                    parts[part.type] = part.value;
                });

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                year: parts.year,
                                month: parts.month,
                                day: parts.day,
                                hour: parts.hour,
                                minute: parts.minute,
                                second: parts.second,
                                weekday: parts.weekday,
                                timestamp: now.getTime(),
                                iso: now.toISOString(),
                                utc: now.toUTCString(),
                                timezone,
                            }, null, 2),
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
