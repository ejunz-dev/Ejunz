import { CardModel, BaseModel } from '../../../model/base';
import storage from '../../../model/storage';
import * as document from '../../../model/document';
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
    const storagePath = `base/${ctx.domainId}/${ctx.baseDocId.toString()}/node/${nodeId}/${fileName}`;
    await storage.put(storagePath, Buffer.from(await response.arrayBuffer()), ctx.owner);
    const meta = await storage.getMeta(storagePath);
    if (!meta) throw new Error('Failed to store file');
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const imageExt = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
    const videoExt = new Set(['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'wmv']);
    const audioExt = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a']);
    const codeExt = new Set(['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'less', 'html', 'json', 'yaml', 'yml', 'xml', 'md', 'sh', 'bash', 'sql', 'vue', 'svelte']);
    const fileType = ext === 'pdf' ? 'pdf' : imageExt.has(ext) ? 'image' : videoExt.has(ext) ? 'video' : audioExt.has(ext) ? 'audio' : codeExt.has(ext) ? 'code' : 'other';
    const title = String(args.title || '').trim() || fileName;
    const cardDocId = await CardModel.create(ctx.domainId, ctx.baseDocId, nodeId, ctx.owner, title, '', undefined, undefined, undefined, 'file', fileType, fileName, meta.size || 0);
    return { ok: true, cardId: String(cardDocId), nodeId, fileName, fileType, fileSize: meta.size };
}
