/** Common city/label -> IANA timezone (e.g. shanghai -> Asia/Shanghai). */
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

/**
 * Execute built-in system tools (e.g. get_current_time).
 * Used by both handler/tool (mcp/tool/call/local) and model/agent (direct fallback).
 */
export function executeSystemTool(name: string, args: Record<string, unknown>): any {
    if (name === 'get_current_time') {
        const raw = (args?.timezone as string) || undefined;
        const timezone = resolveTimezone(raw);
        const now = new Date();
        let iso: string;
        if (timezone) {
            try {
                iso = now.toLocaleString('sv-SE', { timeZone: timezone });
            } catch (e) {
                throw new Error(`Invalid time zone specified: ${raw}. Use IANA name (e.g. Asia/Shanghai) or common alias (e.g. shanghai).`);
            }
        } else {
            iso = now.toISOString();
        }
        return { currentTime: iso, timezone: timezone || 'UTC' };
    }
    throw new Error(`Unknown system tool: ${name}`);
}
