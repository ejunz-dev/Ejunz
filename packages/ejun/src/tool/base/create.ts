import * as document from '../../model/document';
import { BaseModel } from '../../model/base';
import type { McpToolContext, ToolArgs } from '../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const content = typeof args.content === 'string' ? args.content : '';
    const slug = typeof args.slug === 'string' ? args.slug.trim() : undefined;
    const tag = Array.isArray(args.tag)
        ? args.tag.filter((value: unknown): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
        : undefined;
    const created = await BaseModel.create(ctx.domainId, ctx.owner, title, content, undefined, undefined, undefined, undefined, true, tag, document.TYPE_BASE, undefined, slug === undefined ? undefined : { slug });
    const base = await BaseModel.get(ctx.domainId, created.docId, document.TYPE_BASE);
    return { ok: true, baseId: created.docId, base };
}
