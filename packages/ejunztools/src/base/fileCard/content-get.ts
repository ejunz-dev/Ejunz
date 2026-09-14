import type { CardDoc } from 'ejun/src/interface';
import { MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT, MAX_FILE_CONTENT_PAGES } from '../../catalog';
import { fileCardDetail, fileStoragePath, requireCard } from '../shared';
import { readFileContent } from './reader';
import type { ToolArgs, ToolContext } from '../../types';

function optionalCount(raw: unknown, label: string, limit: number): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
        throw new Error(`${label} must be an integer between 1 and ${limit}`);
    }
    return value;
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
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
        ...fileCardDetail(card, ctx.baseDocId),
        ...content,
        reads: { cards: 1, files: 1 },
    };
}
