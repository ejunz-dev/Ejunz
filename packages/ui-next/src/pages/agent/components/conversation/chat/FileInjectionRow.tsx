import { useState } from 'react';
import { DisclosureRow } from '../../primitives/DisclosureRow';
import { fileInjectionText, formatBytes, type UploadedFileMeta } from '../../../runtime/uploads';
import css from './FileInjectionRow.module.css';

export function FileInjectionRow({ files }: { files: UploadedFileMeta[] }) {
    const [open, setOpen] = useState(false);
    const names = files.map((file) => file.originalName).join('、');
    return <DisclosureRow
        className={css.root}
        rowClassName={css.root}
        chevronClassName={css.chevron}
        icon="▤"
        title="文件注入"
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={<>
            <span className={css.sep} aria-hidden />
            <span className={css.count}>{files.length} 个文件</span>
            {names ? <><span className={css.sep} aria-hidden /><span className={css.names}>{names}</span></> : null}
        </>}
    >
        <div className={css.body}>
            <ul className={css.list}>
                {files.map((file) => <li key={file.name} className={css.item}>
                    <span className={css.name}>{file.originalName}</span>
                    <span className={css.meta}>{file.mediaType} · {formatBytes(file.size)}</span>
                    <a className={css.url} href={file.url} target="_blank" rel="noreferrer">{file.url}</a>
                </li>)}
            </ul>
            <pre className={css.json}>{fileInjectionText(files)}</pre>
        </div>
    </DisclosureRow>;
}
