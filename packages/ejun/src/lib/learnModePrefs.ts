/** Learn / Collect / Flag 各自的知识库选择与每日目标（域用户 domain.user 文档） */

export type LearnFlowMode = 'learn' | 'collect' | 'flag';

/** 未写过 collectBaseDocId / flagBaseDocId 时回落到 learnBaseDocId，兼容旧数据 */
export function getModeBaseDocId(
    dudoc: Record<string, unknown> | null | undefined,
    mode: LearnFlowMode,
): number | null {
    const legacyRaw = dudoc?.learnBaseDocId;
    const legacy =
        Number.isFinite(Number(legacyRaw)) && Number(legacyRaw) > 0 ? Number(legacyRaw) : null;

    if (mode === 'learn') {
        return legacy;
    }

    const key = mode === 'collect' ? 'collectBaseDocId' : 'flagBaseDocId';
    const raw = dudoc?.[key];
    if (raw === undefined || raw === null || raw === '') {
        return legacy;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : legacy;
}

/** 未写过 *DailyGoal 时回落到 dailyGoal */
export function getModeDailyGoal(
    dudoc: Record<string, unknown> | null | undefined,
    mode: LearnFlowMode,
): number {
    const legacy = Number(dudoc?.dailyGoal) || 0;
    const key = mode === 'learn' ? 'learnDailyGoal' : mode === 'collect' ? 'collectDailyGoal' : 'flagDailyGoal';
    const raw = dudoc?.[key];
    if (raw === undefined || raw === null || raw === '') {
        return legacy;
    }
    const n = parseInt(String(raw), 10);
    return !Number.isNaN(n) && n >= 0 ? n : legacy;
}
