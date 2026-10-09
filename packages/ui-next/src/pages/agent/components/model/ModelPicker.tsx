import type { SessionModels } from '../types';

interface ModelPickerProps {
    models: SessionModels;
    open: boolean;
    onToggle: () => void;
    onSelect: (provider: string, model: string) => void;
}

export function ModelPicker({ models, open, onToggle, onSelect }: ModelPickerProps) {
    return <div className="eza-modelPicker">
        <button type="button" className="eza-modelButton" onClick={onToggle}>{models.current.model || '选择模型'}</button>
        {open && <div className="eza-modelMenu">
            {models.groups.flatMap((group) => group.models.map((model) => <button key={`${group.id}:${model.id}`} type="button" className={`eza-modelOption${models.current.provider === group.id && models.current.model === model.id ? ' active' : ''}`} onClick={() => onSelect(group.id, model.id)}>
                <span>{model.name}</span>
                <small>{group.name}</small>
            </button>))}
        </div>}
    </div>;
}
