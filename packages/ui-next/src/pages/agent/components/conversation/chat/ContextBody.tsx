import css from './ContextBody.module.css';

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function ContextBody({ text, source, form }: { text: string; source?: unknown; form?: string }) {
    const data = record(source);
    const changes = Array.isArray(data.changes) ? data.changes.map(record).filter((item) => typeof item.path === 'string') : [];
    const references = Array.isArray(data.references) ? data.references.map(record).filter((item) => typeof item.label === 'string') : [];
    const sections = Array.isArray(data.sections) ? data.sections.map(record).filter((item) => typeof item.name === 'string') : [];
    return <>
        {form === 'instructions' && changes.length > 0 && <ul className={css.files}>{changes.map((change, index) => <li key={index} className={css.file}><span className={css.fileAction}>{String(change.action ?? 'set')}</span><span className={css.filePath}>{String(change.path)}</span></li>)}</ul>}
        {form === 'recall' && references.length > 0 && <ul className={css.recalls}>{references.map((reference, index) => <li key={index} className={css.recall}><span className={css.recallLabel}>{String(reference.label)}</span>{reference.messageCount !== undefined && <span className={css.recallCounts}>{String(reference.messageCount)} 条</span>}</li>)}</ul>}
        {form === 'relay' && stringValue(data.sender) && <p className={css.relaySender}>{stringValue(data.sender)}</p>}
        {form === 'snapshot' && sections.length > 0
            ? <div className={css.sections}>{sections.map((section, index) => <section key={index} className={css.section}><span className={css.sectionName}>{String(section.name)}</span><pre className={css.sectionText}>{String(section.text ?? '')}</pre></section>)}</div>
            : <pre className={css.text}>{text}</pre>}
    </>;
}
