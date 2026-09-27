import { useEffect, useRef } from 'react';
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
        void Notification.show({ message: `正在上传 ${uploadingCount} 个文件…`, type: 'info', duration: 0 }).then((id) => {
            noticeRef.current = id;
            if (previous !== null) Notification.hide(previous);
        });
    }, [uploadingCount]);
    useEffect(() => () => {
        if (noticeRef.current !== null) Notification.hide(noticeRef.current);
    }, []);
}
