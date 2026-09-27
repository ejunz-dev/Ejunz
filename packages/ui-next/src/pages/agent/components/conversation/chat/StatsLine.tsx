import css from './StatsLine.module.css';

type Stats = {
    turns?: number;
    steps?: number;
    llmMs?: number;
    toolMs?: number;
    ttftMs?: number;
    ttftSteps?: number;
    decodeMs?: number;
    decodeTokens?: number;
};

type Usage = {
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
};

function numberAt(value: unknown, key: string): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const result = (value as Record<string, unknown>)[key];
    return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
}

function formatTokens(value: number): string {
    if (value < 1000) return String(Math.round(value));
    if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`;
    return `${Math.round(value / 100_000) / 10}M`;
}

function formatDuration(value: number): string {
    const seconds = value / 1000;
    if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

export function StatsLine({ projections }: { projections?: Record<string, unknown> }) {
    const statsValue = projections?.sessionStats;
    const usageValue = projections?.tokenUsage;
    const stats: Stats = {
        turns: numberAt(statsValue, 'turns'),
        steps: numberAt(statsValue, 'steps'),
        llmMs: numberAt(statsValue, 'llmMs'),
        toolMs: numberAt(statsValue, 'toolMs'),
        ttftMs: numberAt(statsValue, 'ttftMs'),
        ttftSteps: numberAt(statsValue, 'ttftSteps'),
        decodeMs: numberAt(statsValue, 'decodeMs'),
        decodeTokens: numberAt(statsValue, 'decodeTokens'),
    };
    const usage: Usage = {
        uncachedInputTokens: numberAt(usageValue, 'uncachedInputTokens'),
        cacheReadTokens: numberAt(usageValue, 'cacheReadTokens'),
        cacheWriteTokens: numberAt(usageValue, 'cacheWriteTokens'),
        outputTokens: numberAt(usageValue, 'outputTokens'),
    };
    const groups: string[] = [];
    if ((stats.steps ?? 0) > 0) {
        groups.push(`${stats.turns ?? 0} 轮 · ${stats.steps} 步`);
        const durations: string[] = [];
        if ((stats.llmMs ?? 0) > 0) durations.push(`LLM ${formatDuration(stats.llmMs!)}`);
        if ((stats.toolMs ?? 0) > 0) durations.push(`工具 ${formatDuration(stats.toolMs!)}`);
        if (durations.length) groups.push(durations.join(' · '));
        const speeds: string[] = [];
        if ((stats.ttftSteps ?? 0) > 0 && (stats.ttftMs ?? 0) > 0) speeds.push(`首 token 平均 ${formatDuration(stats.ttftMs! / stats.ttftSteps!)}`);
        if ((stats.decodeMs ?? 0) > 0 && (stats.decodeTokens ?? 0) > 0) speeds.push(`${(stats.decodeTokens! / (stats.decodeMs! / 1000)).toFixed(1)} tok/s`);
        if (speeds.length) groups.push(speeds.join(' · '));
    }
    const billedInput = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (billedInput > 0 || (usage.outputTokens ?? 0) > 0) {
        if ((usage.cacheReadTokens ?? 0) > 0 && billedInput > 0) groups.push(`缓存命中 ${Math.round((usage.cacheReadTokens! / billedInput) * 100)}%`);
        groups.push(`输入 ${formatTokens(billedInput)} tok · 输出 ${formatTokens(usage.outputTokens ?? 0)} tok`);
    }
    if (!groups.length) return null;
    return <div className={css.root} title={groups.join(' | ')}>{groups.map((group, index) => <span key={group}>{index > 0 && <><span className={css.sep}>|</span>{' '}</>}{group}</span>)}</div>;
}
