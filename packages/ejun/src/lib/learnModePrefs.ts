/** Learn / Collect / Flag: knowledge base selection and daily goals (domain user document). */

export type LearnFlowMode = 'learn' | 'collect' | 'flag';

/** Order in which today's **new**-segment cards are merged (`today` session only; stored on domain.user). */
export type LearnSessionMode = 'deep' | 'breadth' | 'random';

/** How **new** vs **review** arms are sequenced in the frozen daily queue (after counts are chosen). */
export type LearnNewReviewOrder = 'new_first' | 'old_first' | 'shuffle';

function hashStringToSeed32(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Deterministic Fisher–Yates shuffle (stable per `seedStr` for the same list length + content order). */
export function seededShuffle<T>(items: T[], seedStr: string): T[] {
    const a = [...items];
    let state = hashStringToSeed32(seedStr);
    const rnd = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    }
    return a;
}

const LEARN_NEW_REVIEW_ORDER_CHOICES = new Set<LearnNewReviewOrder>(['new_first', 'old_first', 'shuffle']);

export function normalizeLearnNewReviewOrder(raw: unknown): LearnNewReviewOrder {
    const s = String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
    if (s === 'old_first' || s === 'shuffle') return s;
    return 'new_first';
}

export function getLearnNewReviewOrder(dudoc: Record<string, unknown> | null | undefined): LearnNewReviewOrder {
    const n = normalizeLearnNewReviewOrder(dudoc?.learnNewReviewOrder);
    return LEARN_NEW_REVIEW_ORDER_CHOICES.has(n) ? n : 'new_first';
}

/**
 * Merge tagged new vs review slices into the frozen daily queue order.
 * `shuffleSeed` should stay stable for the calendar day (e.g. domainId:uid:YYYY-MM-DD).
 */
export function mergeDailyNewReviewArms<
    TNew extends { todayQueueRole: 'new' },
    TRev extends { todayQueueRole: 'review' },
>(newArm: TNew[], reviewArm: TRev[], order: LearnNewReviewOrder, shuffleSeed: string): (TNew | TRev)[] {
    if (order === 'old_first') return [...reviewArm, ...newArm];
    if (order === 'shuffle') return seededShuffle([...newArm, ...reviewArm], shuffleSeed);
    return [...newArm, ...reviewArm];
}

const RATIO_CHOICES = new Set([1, 2, 3, 4, 5]);

/** Old-segment cards appended after daily **new** slice: count = newCount × N; pool cycles when shorter. */
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

/** Fall back to dailyGoal when *DailyGoal was never written. For learn mode: **new** cards per day when > 0. */
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
