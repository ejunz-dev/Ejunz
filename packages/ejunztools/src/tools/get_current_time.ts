import type { ToolModule } from './types';

const TIMEZONE_ALIASES: Record<string, string> = {
    shanghai: 'Asia/Shanghai',
    beijing: 'Asia/Shanghai',
    china: 'Asia/Shanghai',
    utc: 'UTC',
    gmt: 'UTC',
};

function resolveTimezone(input: string | undefined): string | undefined {
    if (!input || typeof input !== 'string') return undefined;
    const key = input.trim().toLowerCase();
    return TIMEZONE_ALIASES[key] || (key.length >= 2 ? input.trim() : undefined);
}

export const get_current_time: ToolModule = {
    catalog: {
        id: 'get_current_time',
        name: 'get_current_time',
        description: 'Get current server time; optional timezone (e.g. Asia/Shanghai).',
        inputSchema: {
            type: 'object',
            properties: {
                timezone: { type: 'string', description: 'Optional IANA timezone (e.g. Asia/Shanghai)' },
            },
        },
    },
    async execute(args) {
        const raw = (args?.timezone as string) || undefined;
        const timezone = resolveTimezone(raw);
        const now = new Date();
        let iso: string;
        if (timezone) {
            try {
                iso = now.toLocaleString('sv-SE', { timeZone: timezone });
            } catch {
                throw new Error(`Invalid time zone: ${raw}. Use IANA name (e.g. Asia/Shanghai) or alias (e.g. shanghai).`);
            }
        } else {
            iso = now.toISOString();
        }
        return { currentTime: iso, timezone: timezone || 'UTC' };
    },
};
