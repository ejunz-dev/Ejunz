import { useState } from 'react';
import { IconChevronDownOutline14, IconChevronRightOutline14, IconTrashOutline16 } from '../../icons';
import { formatCapacity, parseCapacity, type ModelDraft } from './DeepSeekModelsEditor';
import type { LocaleKey } from './locales';
import type { SettingsRpc } from './modelsStore';
import css from './ModelsSection.module.css';

export interface ProbeTarget {
    settingsNs: string;
    provider?: string;
    baseURL?: string;
    api?: string;
    apiKey?: string;
}

export interface ModelListEditorProps {
    rpc: SettingsRpc;
    models: readonly ModelDraft[];
    overridden?: boolean;
    onChange: (models: ModelDraft[]) => void;
    onReset?: () => void;
    probe: ProbeTarget;
    disabled: boolean;
    t: (key: LocaleKey) => string;
}

type CapacityField = 'contextWindow' | 'maxTokens';

export function ModelListEditor({ rpc, models, overridden, onChange, onReset, probe, disabled, t }: ModelListEditorProps) {
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
    const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map());
    const [discovering, setDiscovering] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [candidates, setCandidates] = useState<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }[] | null>(null);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

    const update = (index: number, key: string, value: unknown) => {
        onChange(models.map((model, at) => {
            if (at !== index) return { ...model };
            const next = { ...model };
            if (value === undefined || value === '') delete next[key];
            else next[key] = value;
            return next;
        }));
    };
    const capacityText = (model: ModelDraft, index: number, field: CapacityField) => editing.get(`${index}:${field}`) ?? (typeof model[field] === 'number' ? formatCapacity(model[field] as number) : '');
    const editCapacity = (index: number, field: CapacityField, value: string) => {
        setEditing((current) => new Map(current).set(`${index}:${field}`, value));
        update(index, field, parseCapacity(value));
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
    const discover = async () => {
        setDiscovering(true);
        setFailure(null);
        try {
            const value = await rpc<{ models?: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] }>('llm.discoverModels', {
                settingsNs: probe.settingsNs,
                ...(probe.provider === undefined ? {} : { provider: probe.provider }),
                ...(probe.baseURL ? { baseURL: probe.baseURL } : {}),
                ...(probe.api ? { api: probe.api } : {}),
                ...(probe.apiKey ? { apiKey: probe.apiKey } : {}),
            });
            const found = Array.isArray(value.models) ? value.models : [];
            if (found.length === 0) setFailure(t('noModels'));
            else {
                const known = new Set(models.map((model) => typeof model.id === 'string' ? model.id : ''));
                setCandidates(found);
                setPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)));
            }
        } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error));
        } finally {
            setDiscovering(false);
        }
    };
    const adopt = () => {
        if (!candidates) return;
        const existing = new Map(models.map((model) => [typeof model.id === 'string' ? model.id : '', model]));
        candidates.forEach((candidate) => {
            if (!picked.has(candidate.id) || existing.has(candidate.id)) return;
            existing.set(candidate.id, { id: candidate.id, ...(candidate.name ? { name: candidate.name } : {}), ...(candidate.contextWindow ? { contextWindow: candidate.contextWindow } : {}), ...(candidate.maxTokens ? { maxTokens: candidate.maxTokens } : {}) });
        });
        onChange([...existing.values()]);
        setCandidates(null);
        setPicked(new Set());
    };

    return <section className={css.modelCatalog} aria-label={t('models')}>
        <div className={css.modelListHead}>
            <div className={css.modelCatalogHeading}>
                <span className={css.modelCatalogTitle}>{t('models')}</span>
                {overridden !== undefined && <span className={css.modelCatalogMeta}>{overridden ? t('modelsCustomized') : t('modelsInherited')}</span>}
            </div>
            {overridden && onReset && <button type="button" className={css.linkButton} disabled={disabled} onClick={onReset}>{t('restoreDefaults')}</button>}
            <button type="button" className={css.linkButton} disabled={disabled || discovering} onClick={() => { void discover(); }}>{discovering ? t('discovering') : t('discover')}</button>
        </div>
        {models.length === 0 ? <p className={css.modelEmpty}>{t('noModels')}</p> : <div className={css.modelList}>
            {models.map((model, index) => <div className={css.modelEntry} key={index}>
                <div className={css.modelRow}>
                    <input className={css.input} value={typeof model.id === 'string' ? model.id : ''} placeholder={t('modelId')} disabled={disabled} onChange={(event) => update(index, 'id', event.target.value)} onBlur={(event) => update(index, 'id', event.target.value.trim())} />
                    <input className={css.input} value={typeof model.name === 'string' ? model.name : ''} placeholder={t('modelName')} disabled={disabled} onChange={(event) => update(index, 'name', event.target.value)} />
                    <button type="button" className={css.iconButton} aria-label={`${t('advanced')} ${index + 1}`} aria-expanded={expanded.has(index)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>{expanded.has(index) ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}</button>
                    <button type="button" className={`${css.iconButton} ${css.iconButtonDanger}`} aria-label={`${t('removeModel')} ${index + 1}`} disabled={disabled} onClick={() => remove(index)}><IconTrashOutline16 size={14} /></button>
                </div>
                {expanded.has(index) && <div className={css.modelAdvanced}>
                    {(['contextWindow', 'maxTokens'] as CapacityField[]).map((field) => <label key={field} className={css.modelField}><span className={css.modelFieldLabel}>{t(field)}</span><input className={css.input} inputMode="numeric" value={capacityText(model, index, field)} disabled={disabled} onChange={(event) => editCapacity(index, field, event.target.value)} /></label>)}
                </div>}
            </div>)}
        </div>}
        <button type="button" className={css.addModelButton} disabled={disabled} onClick={() => onChange([...models.map((model) => ({ ...model })), { id: '' }])}>{t('addModel')}</button>
        {failure && <p className={css.error}>{failure}</p>}
        {candidates && <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => setCandidates(null)} /><div className={css.confirmation} role="dialog" aria-modal="true" aria-labelledby="models-discovery-title"><div className={css.confirmTitle} id="models-discovery-title">{t('chooseModels')}</div><p className={css.advancedHint}>{t('chooseModelsDescription')}</p><ul className={css.candidateList}>{candidates.map((candidate) => <li key={candidate.id} className={css.candidate}><label className={css.candidateLabel}><input type="checkbox" checked={picked.has(candidate.id)} onChange={() => setPicked((current) => { const next = new Set(current); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next; })} /><span className={css.candidateId}>{candidate.id}</span></label></li>)}</ul><div className={css.footer}><button type="button" className={`${css.action} ${css.actionOutline}`} onClick={() => setCandidates(null)}>{t('cancel')}</button><button type="button" className={`${css.action} ${css.actionPrimary}`} onClick={adopt}>{t('addSelected')}</button></div></div></div>}
    </section>;
}
