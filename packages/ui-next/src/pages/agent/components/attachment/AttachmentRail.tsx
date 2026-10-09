import { useEffect, useMemo } from 'react';
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
    return <div className="eza-attachmentRail">
        {attachments.map((attachment, index) => {
            const preview = previews[index];
            const uploading = attachment.meta === undefined && attachment.error === undefined;
            const className = `eza-attachmentThumb${preview === null ? ' eza-attachmentThumb--file' : ''}${attachment.error === undefined ? '' : ' is-error'}`;
            return <div key={attachment.id} className={className} title={attachment.error ?? attachment.originalName}>
                {preview === null
                    ? <span className="eza-attachmentGlyph" aria-hidden>▤</span>
                    : <img src={preview} alt={attachment.originalName} />}
                {preview === null && <span className="eza-attachmentName">{attachment.originalName}</span>}
                {preview === null && <span className="eza-attachmentSize">{formatBytes(attachment.size)}</span>}
                {attachment.error !== undefined && <span className="eza-attachmentError">上传失败</span>}
                {uploading && <span className="eza-attachmentProgress" style={{ width: `${attachment.progress}%` }} />}
                <button type="button" aria-label={`移除 ${attachment.originalName}`} onClick={() => onRemove(attachment.id)}>×</button>
            </div>;
        })}
    </div>;
}
