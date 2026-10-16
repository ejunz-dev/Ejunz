import { useEffect, useRef } from 'react';
import { i18n } from '@/i18n';
import { Notification } from '@ejunz/ui-next';

export function useUploadNotice(uploadingCount: number): void {
    const noticeRef = useRef<number | null>(null);
    useEffect(() => {
        if (uploadingCount === 0) {
            if (noticeRef.current === null) return;
            Notification.hide(noticeRef.current);
            noticeRef.current = null;
            return;
        }
        const previous = noticeRef.current;
        void Notification.show({ message: i18n('Uploading {0} files...', uploadingCount), type: 'info', duration: 0 }).then((id) => {
            noticeRef.current = id;
            if (previous !== null) Notification.hide(previous);
        });
    }, [uploadingCount]);
    useEffect(() => () => {
        if (noticeRef.current !== null) Notification.hide(noticeRef.current);
    }, []);
}
