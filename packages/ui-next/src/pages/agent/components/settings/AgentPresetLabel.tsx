import { IconAgentPresetOutline16 } from '../../icons';
import type { AgentPresetOption } from './AgentPresetSeat';
import css from './AgentPresetControls.module.css';

export function AgentPresetLabel({ preset, options }: { preset?: string; options: readonly AgentPresetOption[] }) {
    if (!preset) return null;
    const option = options.find((item) => item.id === preset);
    return <span className={css.headerLabel} title="本会话运行的 Agent 预设，开始时即固定">
        <IconAgentPresetOutline16 size={14} />
        {option?.name ?? preset}
    </span>;
}
