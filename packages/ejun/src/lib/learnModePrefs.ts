/** Learn / Collect / Flag: knowledge base selection and daily goals (domain user document). */

export type LearnFlowMode = 'learn' | 'collect' | 'flag';

/** Order in which today's learn queue is built (new `today` session only; stored on domain.user). */
export type LearnSessionMode = 'deep' | 'breadth' | 'random';

export function normalizeLearnSessionMode(raw: unknown): LearnSessionMode {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'breadth' || s === 'random') return s;
    return 'deep';
}

/** Default: deep learning (section-by-section depth-first card order). */
export function getLearnSessionMode(dudoc: Record<string, unknown> | null | undefined): LearnSessionMode {
    return normalizeLearnSessionMode(dudoc?.learnSessionMode);
}

/** Collect/Flag: fall back to learnBaseDocId when mode-specific base was never set (legacy). Learn uses training only. */
export function getModeBaseDocId(
    dudoc: Record<string, unknown> | null | undefined,
    mode: LearnFlowMode,
): number | null {
    const legacyRaw = dudoc?.learnBaseDocId;
    const legacy =
        Number.isFinite(Number(legacyRaw)) && Number(legacyRaw) > 0 ? Number(legacyRaw) : null;

    if (mode === 'learn') {
        return null;
    }

    const key = mode === 'collect' ? 'collectBaseDocId' : 'flagBaseDocId';
    const raw = dudoc?.[key];
    if (raw === undefined || raw === null || raw === '') {
        return legacy;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : legacy;
}

/** Fall back to dailyGoal when *DailyGoal was never written. */
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
