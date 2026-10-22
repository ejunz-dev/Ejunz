import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { searchExa } from '../src/lib/exa-search';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('searchExa requires an API key without making a request', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
        requests++;
        throw new Error('fetch must not run without a key');
    }) as typeof fetch;

    await assert.rejects(searchExa('Ejunz', ''), /EXA_API_KEY/);
    assert.equal(requests, 0);
});

test('searchExa calls Exa and returns bounded sources with highlights', async () => {
    const results = Array.from({ length: 9 }, (_, index) => ({
        url: `https://example.com/${index}`,
        title: `Result ${index}`,
        publishedDate: '2026-10-22',
        highlights: [` Highlight ${index} `],
    }));
    results.push(
        { url: 'https://example.com/no-highlight', title: 'No highlight', publishedDate: '', highlights: ['   '] },
        { url: 'ftp://example.com/not-http', title: 'Invalid scheme', publishedDate: '', highlights: ['Ignore'] },
    );
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ results }), { status: 200 });
    }) as typeof fetch;

    const result = await searchExa('  Ejunz Agent tools  ', 'test-exa-key');
    assert.equal(requestUrl, 'https://api.exa.ai/search');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(requestInit?.redirect, 'error');
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-exa-key');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
        query: 'Ejunz Agent tools',
        type: 'auto',
        numResults: 8,
        contents: { highlights: { highlightsPerUrl: 1 } },
    });
    assert.deepEqual(result, {
        sources: Array.from({ length: 8 }, (_, index) => ({
            url: `https://example.com/${index}`,
            title: `Result ${index}`,
            snippet: `Highlight ${index}`,
            publishedAt: '2026-10-22',
        })),
        truncated: true,
    });
});

test('searchExa reports HTTP errors without exposing the API key', async () => {
    globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;

    await assert.rejects(searchExa('Ejunz', 'test-exa-key'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /test-exa-key/);
        return true;
    });
});

test('searchExa rejects malformed Exa response bodies', async () => {
    globalThis.fetch = (async () => new Response('{', { status: 200 })) as typeof fetch;
    await assert.rejects(searchExa('Ejunz', 'test-exa-key'), /invalid JSON/);
});
