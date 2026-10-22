const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_MAX_RESULTS = 8;
const EXA_TIMEOUT_MS = 30_000;

export interface WebSearchSource {
    url: string;
    title?: string;
    snippet?: string;
    publishedAt?: string;
}

export interface WebSearchResult {
    sources: WebSearchSource[];
    truncated: boolean;
}

interface ExaResult {
    url?: unknown;
    title?: unknown;
    publishedDate?: unknown;
    highlights?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

function normalizeExaResponse(value: unknown): WebSearchResult {
    if (!isRecord(value) || !Array.isArray(value.results)) {
        throw new Error('Exa returned an invalid search response.');
    }

    const sources: WebSearchSource[] = [];
    for (const raw of value.results as ExaResult[]) {
        if (!isRecord(raw) || !isHttpUrl(raw.url) || !Array.isArray(raw.highlights)) continue;
        const snippet = raw.highlights.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
        if (snippet === undefined) continue;
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        const publishedAt = typeof raw.publishedDate === 'string' ? raw.publishedDate.trim() : '';
        sources.push({
            url: raw.url,
            ...(title ? { title } : {}),
            snippet: snippet.trim(),
            ...(publishedAt ? { publishedAt } : {}),
        });
    }

    return {
        sources: sources.slice(0, EXA_MAX_RESULTS),
        truncated: sources.length > EXA_MAX_RESULTS,
    };
}

/** Search Exa and return a bounded, provider-neutral source list. */
export async function searchExa(query: string, apiKey: string): Promise<WebSearchResult> {
    query = query.trim();
    apiKey = apiKey.trim();
    if (!query) throw new Error('query is required');
    if (!apiKey) throw new Error('Web search is unavailable: EXA_API_KEY is not configured.');

    let response: Response;
    try {
        response = await fetch(EXA_SEARCH_URL, {
            method: 'POST',
            redirect: 'error',
            headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify({
                query,
                type: 'auto',
                numResults: EXA_MAX_RESULTS,
                contents: { highlights: { highlightsPerUrl: 1 } },
            }),
            signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
        });
    } catch (error) {
        const message = error instanceof Error && error.name === 'TimeoutError'
            ? 'Exa web search timed out.'
            : 'Exa web search request failed.';
        throw new Error(message);
    }

    if (!response.ok) throw new Error(`Exa web search failed (HTTP ${response.status}).`);

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new Error('Exa returned invalid JSON.');
    }
    return normalizeExaResponse(payload);
}
