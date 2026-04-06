/** Learn / Collect / Flag: knowledge base selection and daily goals (domain user document). */

export type LearnFlowMode = 'learn' | 'collect' | 'flag';

/** Order in which today's learn queue is built (new `today` session only; stored on domain.user). */
export type LearnSessionMode = 'deep' | 'breadth' | 'random';

export type LearnSubMode = 'new_only' | 'review_only' | 'mixed';

/** In `mixed` sub-mode: how new vs review cards are ordered (ratio applies except `one_one`). */
export type LearnMixedSchedule = 'review_first' | 'new_first' | 'shuffle' | 'one_one';

export function normalizeLearnMixedSchedule(raw: unknown): LearnMixedSchedule {
    const s = String(raw ?? '').trim().toLowerCase().replace(/-/g, '_');
    if (s === 'review_first' || s === 'reviewfirst') return 'review_first';
    if (s === 'shuffle' || s === 'random_mix' || s === 'randommix') return 'shuffle';
    if (s === 'one_one' || s === 'oneone' || s === 'alternating' || s === '1_1') return 'one_one';
    return 'new_first';
}

export function getLearnMixedSchedule(dudoc: Record<string, unknown> | null | undefined): LearnMixedSchedule {
    return normalizeLearnMixedSchedule(dudoc?.learnMixedSchedule);
}

export function normalizeLearnSubMode(raw: unknown): LearnSubMode {
    const s = String(raw ?? '').trim().toLowerCase().replace(/-/g, '_');
    if (s === 'review_only' || s === 'review' || s === 'reviewonly') return 'review_only';
    if (s === 'mixed' || s === 'new_review' || s === 'newreview') return 'mixed';
    return 'new_only';
}

export function getLearnSubMode(dudoc: Record<string, unknown> | null | undefined): LearnSubMode {
    return normalizeLearnSubMode(dudoc?.learnSubMode);
}

const RATIO_CHOICES = new Set([1, 2, 3, 4, 5]);

/** In `mixed` mode (except `one_one`): target review count = new-card count × this N (1:1 … 1:5); `new_first` / `review_first` use block order, pool cycles if needed. */
export function getLearnNewReviewRatio(dudoc: Record<string, unknown> | null | undefined): number {
    const n = parseInt(String(dudoc?.learnNewReviewRatio ?? '1'), 10);
    return RATIO_CHOICES.has(n) ? n : 1;
}

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
