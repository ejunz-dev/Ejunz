import type { ToolModule } from './types';

const FETCH_WEBPAGE_TIMEOUT_MS = 15000;
const FETCH_WEBPAGE_MAX_LENGTH_DEFAULT = 50000;

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

async function fetchWebpage(
    url: string,
    maxLength: number
): Promise<{ content: string; url: string; title?: string; truncated?: boolean }> {
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

export const fetch_webpage: ToolModule = {
    catalog: {
        id: 'fetch_webpage',
        name: 'fetch_webpage',
        description: 'Fetch webpage at URL and return plain text (for summary or retrieval).',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to fetch (required)' },
                maxLength: { type: 'number', description: 'Max characters to return (default 50000)' },
            },
        },
    },
    async execute(args) {
        const url = args?.url as string | undefined;
        if (!url || typeof url !== 'string' || !url.trim()) {
            throw new Error('fetch_webpage requires url (the page URL to fetch).');
        }
        const trimmed = url.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
            throw new Error('url must start with http:// or https://');
        }
        const maxLength =
            typeof args?.maxLength === 'number' && args.maxLength > 0
                ? Math.min(args.maxLength, 100000)
                : FETCH_WEBPAGE_MAX_LENGTH_DEFAULT;
        return await fetchWebpage(trimmed, maxLength);
    },
};
