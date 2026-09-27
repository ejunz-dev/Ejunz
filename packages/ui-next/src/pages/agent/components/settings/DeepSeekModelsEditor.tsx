import { useState } from 'react';
import { IconChevronDownOutline14, IconChevronRightOutline14, IconPlusOutline16, IconTrashOutline16 } from '../../icons';
import type { LocaleKey } from './locales';
import css from './ModelsSection.module.css';

export type ModelDraft = Record<string, unknown>;
export type DeepSeekModelDraft = ModelDraft;

type CapacityField = 'contextWindow' | 'maxTokens';

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;

export function parseCapacity(text: string): number | undefined {
    const value = text.trim();
    if (value === '') return undefined;
    const match = CAPACITY_PATTERN.exec(value);
    if (!match) return Number.NaN;
    const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1_000 : 1;
    const result = Number(match[1]) * multiplier;
    return Number.isInteger(result) ? result : result;
}

export function formatCapacity(value: number): string {
    if (!Number.isInteger(value) || value <= 0) return String(value);
    if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
    if (value % 1_000 === 0) return `${value / 1_000}K`;
    return String(value);
}

export interface ModelValidationFailure {
    index: number;
    key: 'invalidModel';
}

export function validateDeepSeekModels(value: unknown): ModelValidationFailure | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    for (const [index, item] of value.entries()) {
        const model = item && typeof item === 'object' && !Array.isArray(item) ? item as ModelDraft : {};
        const id = typeof model.id === 'string' ? model.id.trim() : '';
        if (id === '' || seen.has(id)) return { index, key: 'invalidModel' };
        seen.add(id);
        if (model.contextWindow !== undefined && (typeof model.contextWindow !== 'number' || !Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) return { index, key: 'invalidModel' };
        if (model.maxTokens !== undefined && (typeof model.maxTokens !== 'number' || !Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) return { index, key: 'invalidModel' };
    }
    return undefined;
}

export function modelDrafts(value: unknown): ModelDraft[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => item && typeof item === 'object' && !Array.isArray(item) ? { ...(item as ModelDraft) } : { id: '' });
}

export interface DeepSeekModelsEditorProps {
    models: readonly ModelDraft[];
    overridden: boolean;
    defaultContextWindow?: number;
    defaultMaxTokens?: number;
    t: (key: LocaleKey) => string;
    disabled: boolean;
    onChange: (models: ModelDraft[]) => void;
    onReset: () => void;
}

export function DeepSeekModelsEditor({ models, overridden, defaultContextWindow, defaultMaxTokens, t, disabled, onChange, onReset }: DeepSeekModelsEditorProps) {
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
    const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map());

    const update = (index: number, key: string, value: unknown) => {
        onChange(models.map((model, at) => {
            if (at !== index) return { ...model };
            const next = { ...model };
            if (value === undefined || value === '') delete next[key];
            else next[key] = value;
            return next;
        }));
    };
    const capacityText = (model: ModelDraft, index: number, field: CapacityField) => {
        const draft = editing.get(`${index}:${field}`);
        if (draft !== undefined) return draft;
        const value = model[field];
        return typeof value === 'number' ? formatCapacity(value) : '';
    };
    const setCapacity = (index: number, field: CapacityField, text: string) => {
        setEditing((current) => new Map(current).set(`${index}:${field}`, text));
        update(index, field, parseCapacity(text));
    };
    const remove = (index: number) => {
        onChange(models.filter((_model, at) => at !== index).map((model) => ({ ...model })));
        setExpanded((current) => new Set([...current].filter((at) => at !== index).map((at) => at > index ? at - 1 : at)));
        setEditing((current) => new Map([...current].flatMap(([key, value]) => {
            const at = Number(key.slice(0, key.indexOf(':')));
            if (at === index) return [];
            return [[at > index ? key.replace(/^\d+/, String(at - 1)) : key, value] as const];
        })));
    };

    return <section className={css.modelCatalog} aria-label={t('models')}>
        <div className={css.modelListHead}>
            <div className={css.modelCatalogHeading}>
                <span className={css.modelCatalogTitle}>{t('models')}</span>
                <span className={css.modelCatalogMeta}>{overridden ? t('modelsCustomized') : t('modelsInherited')}</span>
            </div>
            {overridden && <button type="button" className={css.linkButton} disabled={disabled} onClick={onReset}>{t('restoreDefaults')}</button>}
        </div>
        {models.length === 0 ? <p className={css.modelEmpty}>{t('noModels')}</p> : <div className={css.modelList}>
            {models.map((model, index) => <div className={css.modelEntry} key={index}>
                <div className={css.modelRow}>
                    <input className={css.input} value={typeof model.id === 'string' ? model.id : ''} placeholder={t('modelId')} aria-label={`${t('modelId')} ${index + 1}`} disabled={disabled} onChange={(event) => update(index, 'id', event.target.value)} onBlur={(event) => update(index, 'id', event.target.value.trim())} />
                    <input className={css.input} value={typeof model.name === 'string' ? model.name : ''} placeholder={t('modelName')} aria-label={`${t('modelName')} ${index + 1}`} disabled={disabled} onChange={(event) => update(index, 'name', event.target.value)} />
                    <button type="button" className={css.iconButton} aria-label={`${t('advanced')} ${index + 1}`} aria-expanded={expanded.has(index)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>{expanded.has(index) ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}</button>
                    <button type="button" className={`${css.iconButton} ${css.iconButtonDanger}`} aria-label={`${t('removeModel')} ${index + 1}`} disabled={disabled} onClick={() => remove(index)}><IconTrashOutline16 size={14} /></button>
                </div>
                {expanded.has(index) && <div className={css.modelAdvanced}>
                    <label className={css.modelField}><span className={css.modelFieldLabel}>{t('contextWindow')}</span><input className={css.input} inputMode="numeric" value={capacityText(model, index, 'contextWindow')} placeholder={defaultContextWindow === undefined ? '' : formatCapacity(defaultContextWindow)} disabled={disabled} onChange={(event) => setCapacity(index, 'contextWindow', event.target.value)} /></label>
                    <label className={css.modelField}><span className={css.modelFieldLabel}>{t('maxTokens')}</span><input className={css.input} inputMode="numeric" value={capacityText(model, index, 'maxTokens')} placeholder={defaultMaxTokens === undefined ? '' : formatCapacity(defaultMaxTokens)} disabled={disabled} onChange={(event) => setCapacity(index, 'maxTokens', event.target.value)} /></label>
                </div>}
            </div>)}
        </div>}
        <button type="button" className={css.addModelButton} disabled={disabled} onClick={() => onChange([...models.map((model) => ({ ...model })), { id: '' }])}><IconPlusOutline16 size={14} />{t('addModel')}</button>
    </section>;
}
