import * as document from 'ejun/src/model/document';
import { BaseModel, loadCardStatsByBaseDocId } from 'ejun/src/model/base';
import type { ToolContext, ToolArgs } from '../types';

function baseUrl(ctx: ToolContext, baseId: number): string {
    const path = `/d/${encodeURIComponent(ctx.domainId)}/base/${encodeURIComponent(String(baseId))}`;
    const site = String(ctx.setting?.get('server.url') || '').trim();
    if (!site || site === '/') return path;
    return `${site.replace(/\/+$/, '')}${path}`;
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const bases = await BaseModel.getAll(ctx.domainId, undefined, document.TYPE_BASE);
    const page = bases.slice(0, limit);
    const cardStats = await loadCardStatsByBaseDocId(ctx.domainId, page.map((item) => item.docId));
    return {
        ok: true,
        query: null,
        count: page.length,
        bases: page.map((item) => {
            const stats = cardStats.get(item.docId);
            return {
                baseId: item.docId,
                title: item.title,
                content: item.content,
                ...(item.slug ? { slug: item.slug } : {}),
                ...(item.tag?.length ? { tag: item.tag } : {}),
                url: baseUrl(ctx, item.docId),
                nodeCount: item.nodes?.length ?? 0,
                cardCount: stats?.cardCount ?? 0,
                problemCount: stats?.problemCount ?? 0,
                createdAt: item.createdAt,
                updateAt: item.updateAt,
            };
        }),
    };
}
