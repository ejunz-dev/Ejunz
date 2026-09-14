import { CardModel, BaseModel } from 'ejun/src/model/base';
import storage from 'ejun/src/model/storage';
import * as document from 'ejun/src/model/document';
import { fileStoragePath, fileTypeOf } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    const fileName = String(args.fileName || '').trim();
    const fileUrl = String(args.fileUrl || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    if (!(base.nodes || []).some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`);
    if (!fileName) throw new Error('fileName is required');
    if (!fileUrl) throw new Error('fileUrl is required');
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    const storagePath = fileStoragePath(ctx, nodeId, fileName);
    await storage.put(storagePath, Buffer.from(await response.arrayBuffer()), ctx.owner);
    const meta = await storage.getMeta(storagePath);
    if (!meta) throw new Error('Failed to store file');
    const fileType = fileTypeOf(fileName);
    const title = String(args.title || '').trim() || fileName;
    const cardDocId = await CardModel.create(ctx.domainId, ctx.baseDocId, nodeId, ctx.owner, title, '', undefined, undefined, undefined, 'file', fileType, fileName, meta.size || 0);
    return { ok: true, cardId: String(cardDocId), nodeId, fileName, fileType, fileSize: meta.size };
}
