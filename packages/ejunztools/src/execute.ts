/** Common city/label -> IANA timezone (e.g. shanghai -> Asia/Shanghai). */
const TIMEZONE_ALIASES: Record<string, string> = {
    shanghai: 'Asia/Shanghai',
    beijing: 'Asia/Shanghai',
    china: 'Asia/Shanghai',
    utc: 'UTC',
    gmt: 'UTC',
};

const FETCH_WEBPAGE_TIMEOUT_MS = 15000;
const FETCH_WEBPAGE_MAX_LENGTH_DEFAULT = 50000;

function resolveTimezone(input: string | undefined): string | undefined {
    if (!input || typeof input !== 'string') return undefined;
    const key = input.trim().toLowerCase();
    return TIMEZONE_ALIASES[key] || (key.length >= 2 ? input.trim() : undefined);
}

function stripHtmlToText(html: string): string {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractTitle(html: string): string | undefined {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim() : undefined;
}

async function fetchWebpage(url: string, maxLength: number): Promise<{ content: string; url: string; title?: string; truncated?: boolean }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_WEBPAGE_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Ejunz-Webpage-Fetcher/1.0' },
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        const html = await res.text();
        const title = extractTitle(html);
        let content = stripHtmlToText(html);
        let truncated = false;
        if (content.length > maxLength) {
            content = content.slice(0, maxLength);
            truncated = true;
        }
        return { content, url, title, truncated };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Execute a built-in system tool by name.
 * Used by handler/tool (mcp/tool/call/local) and model/agent.
 */
export async function executeSystemTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
    if (name === 'fetch_webpage') {
        const url = args?.url as string | undefined;
        if (!url || typeof url !== 'string' || !url.trim()) {
            throw new Error('fetch_webpage 需要参数 url（要抓取的网页地址）');
        }
        const trimmed = url.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
            throw new Error('url 必须以 http:// 或 https:// 开头');
        }
        const maxLength = typeof args?.maxLength === 'number' && args.maxLength > 0
            ? Math.min(args.maxLength, 100000)
            : FETCH_WEBPAGE_MAX_LENGTH_DEFAULT;
        return await fetchWebpage(trimmed, maxLength);
    }
    throw new Error(`Unknown system tool: ${name}`);
}
