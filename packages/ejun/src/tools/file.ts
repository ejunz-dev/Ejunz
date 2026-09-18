import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import type { CardDoc } from 'ejun/src/interface';
import * as document from 'ejun/src/model/document';
import { BaseModel, CardModel } from 'ejun/src/model/base';
import storage from 'ejun/src/model/storage';
import {
    MAX_CARDS_PER_CALL, MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT,
    MAX_FILE_CONTENT_PAGES, MAX_FILE_CREATES_PER_CALL, MAX_FILE_DOWNLOADS_IN_FLIGHT, MAX_NODES_PER_CALL,
} from '../lib/tool-limits';
import {
    asText, cardUrl, cardsById, fileCardDetail, fileCardSummary, fileDownloadUrl,
    fileStoragePath, fileTypeOf, idList, requireCard,
} from '../lib/tool-shared';
import { readFileContent } from '../lib/tool-file-reader';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const List = Schema.object({
    nodeId: Schema.string().required().description('Node id to list file-cards from.'),
}).description('List file-cards under a node. File-cards are cards with cardType="file" that represent uploaded files. Returns card id, title, fileName, fileType, fileSize, the URL that opens the Base at each card and the URL its file is served at.');

export const Get = Schema.object({
    cardId: Schema.string().required().description('File-card docId (hex).'),
}).description('Get file-card metadata by cardId. Returns title, fileName, fileType, fileSize, nodeId, the card text as `content`, the URL that opens the Base at this card, and the URL its file is served at. The file body itself is read by `base_node_fileCard_content_get`.');

export const ContentGet = Schema.object({
    cardId: Schema.string().required().description('File-card docId (hex).'),
    firstPage: Schema.number().step(1).min(1).max(MAX_FILE_CONTENT_PAGES).description('First page to read (PDF only; default the first page).'),
    lastPage: Schema.number().step(1).min(1).max(MAX_FILE_CONTENT_PAGES).description('Last page to read (PDF only; default the last page).'),
    maxChars: Schema.number().step(1).min(1).max(MAX_FILE_CONTENT_CHARS_LIMIT).description(`Cap on the returned text (default ${MAX_FILE_CONTENT_CHARS}).`),
}).description('Read the content of one file-card as text. The stored file is read from the path `base_node_fileCard_create` wrote it to, and the '
    + 'card\'s `fileType` picks the reader: `pdf` is the type implemented today and every other type is refused by name. A PDF is parsed inside '
    + 'this process, with no external command. Returns the fields of `base_node_fileCard_get` plus `text`, `textLength`, `truncated`, `pageCount`, '
    + '`totalPages` and `extractor`. `text` stops at `maxChars` characters and `truncated` reports that, pages are separated by form feeds, and '
    + '`firstPage` / `lastPage` read one range of a long document.');

export const Remove = Schema.object({
    cardId: Schema.string().required().description('File-card docId (hex).'),
}).description('Delete a file-card and its underlying file. Both the card record and the physical file in storage are removed.');

export const Create = Schema.object({
    nodeId: Schema.string().required().description('Existing node id to attach the file-card to.'),
    fileName: Schema.string().required().description('Filename (e.g. report.pdf, photo.png). Used to infer file type from extension.'),
    fileUrl: Schema.string().required().description('Public URL to download the file from.'),
    title: Schema.string().description('Optional card title (defaults to fileName).'),
}).description('Upload a file from a URL and create a file-card under a node. Downloads the file from the given URL, stores it on the node, and creates a file-card (cardType="file") referencing it. Returns the new card id with the URL that opens the Base at it and the URL its file is served at.');

export const CreateMany = Schema.object({
    files: Schema.array(Schema.object({
        nodeId: Schema.string().required().description('Existing node to attach the file-card to (required).'),
        fileName: Schema.string().required().description('Filename (required); it also sets the stored path, so one file per node.'),
        fileUrl: Schema.string().required().description('Public URL to download the file from (required).'),
        title: Schema.string().description('Optional card title (defaults to fileName).'),
    })).min(1).max(MAX_FILE_CREATES_PER_CALL).required().description('Files to download and store, in order.'),
}).description('Store several files on nodes of one Base in a single call, each becoming a file-card, as `base_node_fileCard_create` makes one. '
    + '`files` is an array of `{ nodeId, fileName, fileUrl, title? }`. The Base is read once to check every node and the whole list is validated '
    + 'before the first download, so a refused call stores nothing. The downloads run a few at a time, and every entry is reported on its own: a '
    + `download or a card the server refuses is named in \`refusedFiles\` and \`ok\` is false, while the files that arrived stay. One call stores at most ${MAX_FILE_CREATES_PER_CALL} files, and every stored file carries the URL that opens the Base at its card and the URL its file is served at.`);

export const ListMany = Schema.object({
    nodeIds: Schema.array(Schema.string()).min(1).max(MAX_NODES_PER_CALL).required().description('Nodes whose files are wanted.'),
}).description('List the files of several nodes in a single call, each node reported as `base_node_fileCard_list` reports it. The Base document is read '
    + 'once and the cards of every named node come from one further read, so the call costs two reads however many nodes it names. A read changes '
    + `nothing, so a node this Base does not hold is listed in \`missingNodeIds\` and \`ok\` is false. One call lists at most ${MAX_NODES_PER_CALL} nodes.`);

export const GetMany = Schema.object({
    cardIds: Schema.array(Schema.string()).min(1).max(MAX_CARDS_PER_CALL).required().description('File-cards to read.'),
}).description('Read several file-cards in a single call, each reported as `base_node_fileCard_get` reports one: its name, type, size, node, content, '
    + 'the URL that opens the Base at its card and the URL its file is served at. The cards come from one read, so the call costs one read however many it names. A read changes nothing, so a '
    + `card this Base does not hold, or one that is not a file-card, is listed in \`missing\` with its reason and \`ok\` is false. One call reads at most ${MAX_CARDS_PER_CALL} cards.`);

export const RemoveMany = Schema.object({
    cardIds: Schema.array(Schema.string()).min(1).max(MAX_CARDS_PER_CALL).required().description('File-cards to remove.'),
}).description('Delete several file-cards of one Base in a single call, with the file each one holds. Each card is removed as '
    + '`base_node_fileCard_delete` removes one: the stored body first, then the card. The cards are read once, and a card this Base does not hold, or '
    + `one that is not a file-card, refuses the whole call before anything is removed. Use it instead of calling \`base_node_fileCard_delete\` once per card. One call removes at most ${MAX_CARDS_PER_CALL} cards.`);

function optionalCount(raw: unknown, label: string, limit: number): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
        throw new Error(`${label} must be an integer between 1 and ${limit}`);
    }
    return value;
}

export async function list(ctx: ToolContext, args: ToolArgs) {
    const nodeId = String(args.nodeId || '');
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    if (!(base.nodes || []).some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`);
    const cards = await CardModel.getByNodeId(ctx.domainId, ctx.baseDocId, nodeId);
    return cards.filter((card) => (card as CardDoc).cardType === 'file').map((card) => fileCardSummary(ctx, card));
}

export async function get(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${args.cardId}`);
    return fileCardDetail(ctx, card);
}

export async function contentGet(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId) as CardDoc;
    if (card.cardType !== 'file') throw new Error(`Not a file-card: ${args.cardId}`);
    const fileName = card.fileName || '';
    if (!fileName) throw new Error(`File-card ${args.cardId} names no stored file`);
    const firstPage = optionalCount(args.firstPage, 'firstPage', MAX_FILE_CONTENT_PAGES);
    const lastPage = optionalCount(args.lastPage, 'lastPage', MAX_FILE_CONTENT_PAGES);
    if (firstPage !== undefined && lastPage !== undefined && lastPage < firstPage) {
        throw new Error(`lastPage ${lastPage} is before firstPage ${firstPage}`);
    }
    const content = await readFileContent({
        storagePath: fileStoragePath(ctx, card.nodeId, fileName),
        fileType: card.fileType || '',
        fileSize: card.fileSize || 0,
        firstPage,
        lastPage,
        maxChars: optionalCount(args.maxChars, 'maxChars', MAX_FILE_CONTENT_CHARS_LIMIT) ?? MAX_FILE_CONTENT_CHARS,
    });
    return {
        ok: true,
        ...fileCardDetail(ctx, card),
        ...content,
        reads: { cards: 1, files: 1 },
    };
}

export async function remove(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${args.cardId}`);
    const fileName = (card as CardDoc).fileName;
    if (fileName) {
        const storagePath = fileStoragePath(ctx, card.nodeId, fileName);
        try { await storage.del([storagePath], ctx.owner); } catch { /* ignore missing storage */ }
    }
    await CardModel.delete(ctx.domainId, card.docId);
    return { ok: true, cardId: String(args.cardId), deletedFile: !!fileName };
}

export async function create(ctx: ToolContext, args: ToolArgs) {
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
    return {
        ok: true,
        cardId: String(cardDocId),
        nodeId,
        fileName,
        fileType,
        fileSize: meta.size,
        url: cardUrl(ctx, ctx.baseDocId, String(cardDocId)),
        downloadUrl: fileDownloadUrl(ctx, ctx.baseDocId, nodeId, fileName),
    };
}

export async function createMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.files;
    if (!Array.isArray(raw) || !raw.length) throw new Error('files must be a non-empty array of { nodeId, fileName, fileUrl }');
    if (raw.length > MAX_FILE_CREATES_PER_CALL) {
        throw new Error(`files holds ${raw.length} entries and one call stores ${MAX_FILE_CREATES_PER_CALL}; split the work across calls`);
    }
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodeIds = new Set((base.nodes || []).map((node) => node.id));
    const planned: { index: number; nodeId: string; fileName: string; fileUrl: string; title: string }[] = [];
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
    type StoredFile = {
        ok: true; index: number; cardId: string; nodeId: string; fileName: string;
        fileType: string; fileSize: number; url: string; downloadUrl: string;
    };
    type RefusedFile = { ok: false; index: number; nodeId: string; fileName: string; error: string };
    const results: (StoredFile | RefusedFile)[] = new Array(planned.length);
    const storeOne = async (file: typeof planned[number]): Promise<StoredFile | RefusedFile> => {
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
                return {
                    ok: true,
                    index: file.index,
                    cardId: String(cardId),
                    nodeId: file.nodeId,
                    fileName: file.fileName,
                    fileType,
                    fileSize: meta.size || 0,
                    url: cardUrl(ctx, ctx.baseDocId, String(cardId)),
                    downloadUrl: fileDownloadUrl(ctx, ctx.baseDocId, file.nodeId, file.fileName),
                };
            } catch (error) {
                try { await storage.del([storagePath], ctx.owner); } catch { /* ignore cleanup */ }
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

export async function listMany(ctx: ToolContext, args: ToolArgs) {
    const nodeIds = idList(args.nodeIds, 'nodeIds', MAX_NODES_PER_CALL);
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const known = new Set((base.nodes || []).map((node) => node.id));
    const missing = nodeIds.filter((nodeId) => !known.has(nodeId));
    const present = nodeIds.filter((nodeId) => known.has(nodeId));
    const cardsByNode = await CardModel.getByNodeIds(ctx.domainId, ctx.baseDocId, present);
    const nodes = present.map((nodeId, index) => {
        const files = (cardsByNode.get(nodeId) || []).filter((card) => (card as CardDoc).cardType === 'file');
        return { index, nodeId, files: files.map((card) => fileCardSummary(ctx, card)) };
    });
    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        nodeCount: nodes.length,
        nodes,
        fileCount: nodes.reduce((sum, node) => sum + node.files.length, 0),
        missingNodeIds: missing,
        reads: { base: 1, cards: 1 },
    };
}

export async function getMany(ctx: ToolContext, args: ToolArgs) {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const byId = await cardsById(ctx, cardIds);
    const files: unknown[] = [];
    const missing: { index: number; cardId: string; error: string }[] = [];
    for (const [index, cardId] of cardIds.entries()) {
        const card = byId.get(cardId);
        if (!card) {
            missing.push({ index, cardId, error: 'Card not found' });
            continue;
        }
        if ((card as CardDoc).cardType !== 'file') {
            missing.push({ index, cardId, error: `Not a file-card: ${cardId}` });
            continue;
        }
        files.push({ index, ...fileCardDetail(ctx, card) });
    }
    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        fileCount: files.length,
        files,
        missing,
        reads: { cards: 1 },
    };
}

export async function removeMany(ctx: ToolContext, args: ToolArgs) {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const byId = await cardsById(ctx, cardIds);
    for (const cardId of cardIds) {
        const card = byId.get(cardId);
        if (!card) throw new Error(`Card not found: ${cardId}`);
        if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${cardId}`);
    }
    const removed: string[] = [];
    let deletedFiles = 0;
    for (const cardId of cardIds) {
        const card = byId.get(cardId) as CardDoc;
        const fileName = card.fileName;
        if (fileName) {
            try {
                await storage.del([fileStoragePath(ctx, card.nodeId, fileName)], ctx.owner);
                deletedFiles += 1;
            } catch { /* ignore missing storage */ }
        }
        await CardModel.delete(ctx.domainId, card.docId);
        removed.push(cardId);
    }
    return {
        ok: true,
        baseId: ctx.baseDocId,
        removedCardIds: removed,
        removedCount: removed.length,
        deletedFiles,
        reads: { cards: 1 },
        writes: { files: deletedFiles, cards: removed.length },
    };
}

export function apply(ctx: Context) {
    const opts = { source: 'base' as const, bindBase: 'session' as const };
    ctx.Tool('base_node_fileCard_list', list, List, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_get', get, Get, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_content_get', contentGet, ContentGet, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_delete', remove, Remove, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_create', create, Create, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_create_many', createMany, CreateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_list_many', listMany, ListMany, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_get_many', getMany, GetMany, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_fileCard_delete_many', removeMany, RemoveMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
}
