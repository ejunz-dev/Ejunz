import { i18n } from '@/i18n';
import type { SessionModels } from '../types';

interface ModelPickerProps {
    models: SessionModels;
    open: boolean;
    onToggle: () => void;
    onSelect: (provider: string, model: string) => void;
}

export function ModelPicker({ models, open, onToggle, onSelect }: ModelPickerProps) {
    return <div className="ea-modelPicker">
        <button type="button" className="ea-modelButton" onClick={onToggle}>{models.current.model || i18n('Choose a model')}</button>
        {open && <div className="ea-modelMenu">
            {models.groups.flatMap((group) => group.models.map((model) => <button key={`${group.id}:${model.id}`} type="button" className={`ea-modelOption${models.current.provider === group.id && models.current.model === model.id ? ' active' : ''}`} onClick={() => onSelect(group.id, model.id)}>
                <span>{model.name}</span>
                <small>{group.name}</small>
            </button>))}
        </div>}
    </div>;
}
