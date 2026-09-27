export const FILE_INJECTION_PLUGIN = 'ejunz-file-injection';
export const FILE_INJECTION_SECTION = 'file-injection';

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export interface UploadedFileMeta {
    name: string;
    originalName: string;
    mediaType: string;
    size: number;
    url: string;
    uploadedAt: string;
}

export interface DraftAttachment {
    id: string;
    local: File;
    originalName: string;
    mediaType: string;
    size: number;
    progress: number;
    error?: string;
    meta?: UploadedFileMeta;
}

export function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function randomToken(length = 6): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const values = new Uint32Array(length);
    crypto.getRandomValues(values);
    let token = '';
    for (let index = 0; index < length; index += 1) token += alphabet[values[index] % alphabet.length];
    return token;
}

export function attachmentId(): string {
    return `att-${Date.now().toString(36)}-${randomToken(4)}`;
}

export function storedFileName(file: File): string {
    const name = file.name || 'file';
    const match = /^(.*?)(\.[^./\\]*)?$/.exec(name);
    const rawStem = (match?.[1] || 'file').trim();
    const stem = rawStem.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60) || 'file';
    const extension = (match?.[2] || '').slice(0, 12);
    return `${stem}-${randomToken()}${extension}`;
}

function errorMessage(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== 'object') return undefined;
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message ? message : undefined;
}

function responseMessage(text: string): string | undefined {
    if (!text) return undefined;
    try {
        return errorMessage(JSON.parse(text));
    } catch {
        return undefined;
    }
}

export function uploadFileToStore(options: {
    prefix: string;
    ownerId: number | string;
    file: File;
    onProgress?: (percent: number) => void;
}): Promise<UploadedFileMeta> {
    const { prefix, ownerId, file, onProgress } = options;
    const name = storedFileName(file);
    return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('filename', name);
        form.append('file', file, name);
        form.append('operation', 'upload_file');
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${prefix}/file`);
        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        });
        xhr.addEventListener('load', () => {
            if ((xhr.responseURL || '').includes('/login')) {
                reject(new Error('登录已过期，请刷新页面后重试'));
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                reject(new Error(responseMessage(xhr.responseText) || `上传失败（HTTP ${xhr.status}）`));
                return;
            }
            onProgress?.(100);
            resolve({
                name,
                originalName: file.name || name,
                mediaType: file.type || 'application/octet-stream',
                size: file.size,
                url: `${window.location.origin}${prefix}/file/${ownerId}/${encodeURIComponent(name)}`,
                uploadedAt: new Date().toISOString(),
            });
        });
        xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
        xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
        xhr.send(form);
    });
}

export function fileInjectionText(files: UploadedFileMeta[]): string {
    return JSON.stringify({
        kind: 'file-injection',
        note: '用户随消息上传的文件，已存入 Ejunz 文件仓库；url 无需登录即可下载。需要文件内容或地址的工具请直接使用 url（例如把文件加入某个 Base 作为文件卡片时传入 fileUrl）。',
        files,
    }, null, 2);
}

function fileMeta(value: unknown): UploadedFileMeta | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const { name, originalName, mediaType, size, url, uploadedAt } = record;
    if (typeof name !== 'string' || typeof url !== 'string') return null;
    return {
        name,
        originalName: typeof originalName === 'string' ? originalName : name,
        mediaType: typeof mediaType === 'string' ? mediaType : 'application/octet-stream',
        size: typeof size === 'number' ? size : 0,
        url,
        uploadedAt: typeof uploadedAt === 'string' ? uploadedAt : '',
    };
}

export function parseFileInjection(text: string): UploadedFileMeta[] {
    try {
        const parsed = JSON.parse(text) as { files?: unknown };
        if (!Array.isArray(parsed.files)) return [];
        return parsed.files.map(fileMeta).filter((file): file is UploadedFileMeta => file !== null);
    } catch {
        return [];
    }
}
