/**
 * System tools catalog (market "system" tools).
 * Used by tool market and agent for listing/executing built-in system tools.
 */
export interface SystemToolEntry {
    id: string;
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, { type: string; description?: string }>;
    };
}

export const SYSTEM_TOOLS_CATALOG: SystemToolEntry[] = [
    {
        id: 'get_current_time',
        name: 'get_current_time',
        description: '查询当前服务器时间',
        inputSchema: {
            type: 'object',
            properties: {
                timezone: { type: 'string', description: '可选时区，如 Asia/Shanghai' },
            },
        },
    },
    {
        id: 'fetch_webpage',
        name: 'fetch_webpage',
        description: '网页抓取：获取指定 URL 的网页内容（纯文本，适合摘要或检索）',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '要抓取的网页 URL（必填）' },
                maxLength: { type: 'number', description: '返回内容最大字符数，默认 50000' },
            },
        },
    },
];
