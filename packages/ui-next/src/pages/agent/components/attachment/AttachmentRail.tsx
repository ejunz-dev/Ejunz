import { useEffect, useMemo } from 'react';
import { i18n } from '@/i18n';
import { formatBytes, type DraftAttachment } from '../../runtime/uploads';

interface AttachmentRailProps {
    attachments: DraftAttachment[];
    onRemove: (id: string) => void;
}

export function AttachmentRail({ attachments, onRemove }: AttachmentRailProps) {
    const previews = useMemo(() => attachments.map((attachment) => (
        attachment.mediaType.startsWith('image/') ? URL.createObjectURL(attachment.local) : null
    )), [attachments]);
    useEffect(() => () => previews.forEach((url) => { if (url !== null) URL.revokeObjectURL(url); }), [previews]);
    if (!attachments.length) return null;
    return <div className="ea-attachmentRail">
        {attachments.map((attachment, index) => {
            const preview = previews[index];
            const uploading = attachment.meta === undefined && attachment.error === undefined;
            const className = `ea-attachmentThumb${preview === null ? ' ea-attachmentThumb--file' : ''}${attachment.error === undefined ? '' : ' is-error'}`;
            return <div key={attachment.id} className={className} title={attachment.error ?? attachment.originalName}>
                {preview === null
                    ? <span className="ea-attachmentGlyph" aria-hidden>▤</span>
                    : <img src={preview} alt={attachment.originalName} />}
                {preview === null && <span className="ea-attachmentName">{attachment.originalName}</span>}
                {preview === null && <span className="ea-attachmentSize">{formatBytes(attachment.size)}</span>}
                {attachment.error !== undefined && <span className="ea-attachmentError">{i18n('Upload failed')}</span>}
                {uploading && <span className="ea-attachmentProgress" style={{ width: `${attachment.progress}%` }} />}
                <button type="button" aria-label={i18n('Remove {0}', attachment.originalName)} onClick={() => onRemove(attachment.id)}>×</button>
            </div>;
        })}
    </div>;
}
