import * as document from '../../model/document';
import { BaseModel } from '../../model/base';
import type { ToolContext, ToolArgs } from '../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(args, 'title')) {
        const title = String(args.title || '').trim();
        if (!title) throw new Error('title cannot be empty');
        updates.title = title;
    }
    if (typeof args.content === 'string') updates.content = args.content;
    if (typeof args.slug === 'string') updates.slug = args.slug.trim();
    if (Array.isArray(args.tag)) updates.tag = args.tag.filter((value: unknown): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean);
    if (Object.keys(updates).length === 0) throw new Error('Nothing to update');
    await BaseModel.update(ctx.domainId, ctx.baseDocId, updates as Parameters<typeof BaseModel.update>[2], document.TYPE_BASE);
    return { ok: true, baseId: ctx.baseDocId, base: await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE) };
}
