import { extractText } from 'unpdf';
import storage from 'ejun/src/model/storage';
import { streamToBuffer } from 'ejun/src/utils';
import { MAX_FILE_CONTENT_BYTES } from './tool-limits';

const PAGE_BREAK = '\f';
const EXTRACTOR = 'unpdf';

export interface FileContent {
    text: string;
    textLength: number;
    truncated: boolean;
    pageCount: number;
    totalPages: number;
    extractor: string;
}

export interface FileContentRequest {
    storagePath: string;
    fileType: string;
    fileSize: number;
    firstPage?: number;
    lastPage?: number;
    maxChars: number;
}

export async function readFileContent(request: FileContentRequest): Promise<FileContent> {
    if (request.fileType !== 'pdf') {
        const named = request.fileType || 'this';
        throw new Error(`Reading ${named} file content is not implemented yet; this tool reads pdf. `
            + 'base_node_fileCard_get reports the metadata and the URL the file is served at.');
    }
    if (request.fileSize > MAX_FILE_CONTENT_BYTES) {
        throw new Error(`The stored file holds ${request.fileSize} bytes and one read takes ${MAX_FILE_CONTENT_BYTES}; `
            + 'base_node_fileCard_get reports the URL the file is served at.');
    }
    const pages = await readPdfPages(request.storagePath);
    const firstPage = request.firstPage ?? 1;
    if (firstPage > pages.length) {
        throw new Error(`The document holds ${pages.length} page(s) and firstPage is ${firstPage}`);
    }
    const selected = pages.slice(firstPage - 1, Math.min(request.lastPage ?? pages.length, pages.length));
    const text = selected.join(PAGE_BREAK);
    const truncated = text.length > request.maxChars;
    return {
        text: truncated ? text.slice(0, request.maxChars) : text,
        textLength: text.length,
        truncated,
        pageCount: selected.length,
        totalPages: pages.length,
        extractor: EXTRACTOR,
    };
}

async function readPdfPages(storagePath: string): Promise<string[]> {
    let bytes: Buffer;
    try {
        bytes = await streamToBuffer(await storage.get(storagePath));
    } catch (error) {
        throw new Error(`The stored file ${storagePath} could not be read: ${(error as Error).message}`);
    }
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    try {
        const { text } = await extractText(data, { mergePages: false });
        return text;
    } catch (error) {
        throw new Error(`The PDF could not be parsed: ${(error as Error).message}`);
    }
}
