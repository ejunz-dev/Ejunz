import { i18n } from '@/i18n';
import { IconAgentPresetOutline16 } from '../../icons';
import type { AgentPresetOption } from './AgentPresetSeat';
import css from './AgentPresetControls.module.css';

export function AgentPresetLabel({ preset, options }: { preset?: string; options: readonly AgentPresetOption[] }) {
    if (!preset) return null;
    const option = options.find((item) => item.id === preset);
    return <span className={css.headerLabel} title={i18n('The Agent preset this session runs. It is fixed when the session starts.')}>
        <IconAgentPresetOutline16 size={14} />
        {option?.name ?? preset}
    </span>;
}
