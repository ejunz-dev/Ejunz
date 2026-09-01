import * as document from '../../model/document';
import { BaseModel } from '../../model/base';
import type { McpToolContext, ToolArgs } from '../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const query = String(args.query || '').trim().toLowerCase();
    if (!query) throw new Error('query is required');
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const bases = await BaseModel.getAll(ctx.domainId, undefined, document.TYPE_BASE);
    const matches = bases.filter((item) => [item.title, item.content, item.slug, ...(item.tag || [])].filter((value): value is string => typeof value === 'string').some((value) => value.toLowerCase().includes(query)));
    return { ok: true, query, count: Math.min(matches.length, limit), bases: matches.slice(0, limit).map((item) => ({ baseId: item.docId, title: item.title, content: item.content, ...(item.slug ? { slug: item.slug } : {}), ...(item.tag?.length ? { tag: item.tag } : {}), createdAt: item.createdAt, updateAt: item.updateAt })) };
}
