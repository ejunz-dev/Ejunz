import * as document from 'ejun/src/model/document';
import { CardModel, BaseModel } from 'ejun/src/model/base';
import storage from 'ejun/src/model/storage';
import { MAX_FILE_CREATES_PER_CALL, MAX_FILE_DOWNLOADS_IN_FLIGHT } from '../../catalog';
import { asText, fileStoragePath, fileTypeOf } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedFile {
    index: number;
    nodeId: string;
    fileName: string;
    fileUrl: string;
    title: string;
}

interface StoredFile {
    ok: true;
    index: number;
    cardId: string;
    nodeId: string;
    fileName: string;
    fileType: string;
    fileSize: number;
}

interface RefusedFile {
    ok: false;
    index: number;
    nodeId: string;
    fileName: string;
    error: string;
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.files;
    if (!Array.isArray(raw) || !raw.length) throw new Error('files must be a non-empty array of { nodeId, fileName, fileUrl }');
    if (raw.length > MAX_FILE_CREATES_PER_CALL) {
        throw new Error(`files holds ${raw.length} entries and one call stores ${MAX_FILE_CREATES_PER_CALL}; split the work across calls`);
    }
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodeIds = new Set((base.nodes || []).map((node) => node.id));

    const planned: PlannedFile[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`files[${index}] must be an object`);
        const fields = entry as Record<string, unknown>;
        const nodeId = asText(fields.nodeId);
        if (!nodeId) throw new Error(`files[${index}].nodeId is required`);
        if (!nodeIds.has(nodeId)) throw new Error(`files[${index}].nodeId ${nodeId} is not a node of this Base`);
        const fileName = asText(fields.fileName);
        if (!fileName) throw new Error(`files[${index}].fileName is required`);
        const fileUrl = asText(fields.fileUrl);
        if (!fileUrl) throw new Error(`files[${index}].fileUrl is required`);
        const stored = `${nodeId}/${fileName}`;
        if (seen.has(stored)) throw new Error(`files[${index}] stores ${fileName} on ${nodeId} twice; one file per node holds one path`);
        seen.add(stored);
        planned.push({ index, nodeId, fileName, fileUrl, title: asText(fields.title) || fileName });
    }

    const results: (StoredFile | RefusedFile)[] = new Array(planned.length);
    const storeOne = async (file: PlannedFile): Promise<StoredFile | RefusedFile> => {
        const storagePath = fileStoragePath(ctx, file.nodeId, file.fileName);
        try {
            const response = await fetch(file.fileUrl);
            if (!response.ok) throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
            await storage.put(storagePath, Buffer.from(await response.arrayBuffer()), ctx.owner);
            const meta = await storage.getMeta(storagePath);
            if (!meta) throw new Error('Failed to store file');
            const fileType = fileTypeOf(file.fileName);
            try {
                const cardId = await CardModel.create(
                    ctx.domainId, ctx.baseDocId, file.nodeId, ctx.owner, file.title, '',
                    undefined, undefined, undefined, 'file', fileType, file.fileName, meta.size || 0,
                );
                return { ok: true, index: file.index, cardId: String(cardId), nodeId: file.nodeId, fileName: file.fileName, fileType, fileSize: meta.size || 0 };
            } catch (error) {

                try {
                    await storage.del([storagePath], ctx.owner);
                } catch (cleanup) {
                }
                throw error;
            }
        } catch (error) {
            return { ok: false, index: file.index, nodeId: file.nodeId, fileName: file.fileName, error: (error as Error).message };
        }
    };

    let next = 0;
    const worker = async () => {
        while (next < planned.length) {
            const file = planned[next];
            next += 1;
            results[file.index] = await storeOne(file);
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_FILE_DOWNLOADS_IN_FLIGHT, planned.length) }, worker));

    const stored = results.filter((result) => result.ok) as StoredFile[];
    const refused = results.filter((result) => !result.ok) as RefusedFile[];
    return {
        ok: refused.length === 0,
        baseId: ctx.baseDocId,
        fileCount: stored.length,
        files: stored,
        refusedFiles: refused,
        reads: { base: 1 },
        writes: { files: stored.length, cards: stored.length },
    };
}
