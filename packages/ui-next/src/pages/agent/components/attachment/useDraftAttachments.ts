import { useCallback, useState } from 'react';
import { Notification } from '@ejunz/ui-next';
import { attachmentId, uploadFileToStore, type DraftAttachment } from '../../runtime/uploads';
import { useUploadNotice } from './useUploadNotice';

export interface DraftAttachments {
    attachments: DraftAttachment[];
    addFiles: (files: File[]) => void;
    removeAttachment: (id: string) => void;
    clear: () => void;
}

export function useDraftAttachments(options: { prefix: string; ownerId: number | string | undefined }): DraftAttachments {
    const { prefix, ownerId } = options;
    const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
    useUploadNotice(attachments.filter((attachment) => attachment.meta === undefined && attachment.error === undefined).length);

    const patchAttachment = useCallback((id: string, patch: Partial<DraftAttachment>) => {
        setAttachments((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    }, []);

    const addFiles = useCallback((files: File[]) => {
        if (files.length === 0 || ownerId === undefined || ownerId === null) return;
        const drafts: DraftAttachment[] = files.map((file) => ({
            id: attachmentId(),
            local: file,
            originalName: file.name || 'file',
            mediaType: file.type || 'application/octet-stream',
            size: file.size,
            progress: 0,
        }));
        setAttachments((items) => [...items, ...drafts]);
        for (const draft of drafts) {
            void uploadFileToStore({
                prefix,
                ownerId,
                file: draft.local,
                onProgress: (percent) => patchAttachment(draft.id, { progress: percent }),
            })
                .then((meta) => {
                    patchAttachment(draft.id, { meta, progress: 100 });
                    void Notification.success(`已上传 ${meta.originalName}`);
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    patchAttachment(draft.id, { error: message });
                    void Notification.error(`上传失败：${message}`);
                });
        }
    }, [ownerId, patchAttachment, prefix]);

    const removeAttachment = useCallback((id: string) => {
        setAttachments((items) => items.filter((item) => item.id !== id));
    }, []);

    const clear = useCallback(() => { setAttachments([]); }, []);

    return { attachments, addFiles, removeAttachment, clear };
}
