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
            name: 'get_current_time',
            description: 'Get current time',
            inputSchema: {
                type: 'object',
                properties: {
                    timezone: {
                        type: 'string',
                        description: 'Timezone, e.g., Asia/Shanghai, America/New_York',
                    },
                    format: {
                        type: 'string',
                        description: 'Time format: ISO (default), locale, or custom',
                        enum: ['ISO', 'locale', 'custom'],
                    },
                },
            },
        },
        {
            name: 'get_time_info',
            description: 'Get detailed time information',
            inputSchema: {
                type: 'object',
                properties: {
                    timezone: {
                        type: 'string',
                        description: 'Timezone, e.g., Asia/Shanghai',
                    },
                },
            },
        },
    ];
}

function callTool(name: string, args: any): any {
    const now = new Date();

    switch (name) {
        case 'get_current_time': {
            const timezone = args?.timezone || 'Asia/Shanghai';
            const format = args?.format || 'ISO';
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
                timestamp: now.getTime(),
                iso: now.toISOString(),
                formatted: formattedTime,
                timezone,
            };
        }

        case 'get_time_info': {
            const timezone = args?.timezone || 'Asia/Shanghai';
            
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
    
    ctx.on('mcp/tool/call' as any, (data: any) => {
        logger.info(`Tool call: ${data.name}`, data.args);
        addLog('info', `Tool call: ${data.name}, args: ${JSON.stringify(data.args)}`);
        
        try {
            const result = callTool(data.name, data.args);
            
            logger.info(`Tool ${data.name} returned:`, result);
            addLog('info', `Tool ${data.name} returned: ${JSON.stringify(result)}`);
            
            return result;
        } catch (error: any) {
            logger.error(`Tool call failed: ${data.name}`, error.message);
            addLog('error', `Tool call failed: ${data.name}, error: ${error.message}`);
            throw error;
        }
    });
    
    addLog('info', 'MCP Provider initialized');
    logger.info('MCP Provider initialized');
}

