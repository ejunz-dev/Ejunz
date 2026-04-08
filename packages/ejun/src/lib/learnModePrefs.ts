/** Learn: knowledge base selection and daily goals (domain user document). */

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

/** 1:0 = new only; 0:1 = review only (count = daily goal); 1:N = mixed (review ≈ new×N). */
const LEARN_NEW_REVIEW_RATIO_VALUES = new Set([-1, 0, 1, 2, 3, 4, 5]);

/** Old-segment cards appended after daily **new** slice: count = newCount × N; pool cycles when shorter. */
export function getLearnNewReviewRatio(dudoc: Record<string, unknown> | null | undefined): number {
    const n = parseInt(String(dudoc?.learnNewReviewRatio ?? '1'), 10);
    return LEARN_NEW_REVIEW_RATIO_VALUES.has(n) ? n : 1;
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

export function getLearnBaseDocId(dudoc: Record<string, unknown> | null | undefined): number | null {
    const legacyRaw = dudoc?.learnBaseDocId;
    return Number.isFinite(Number(legacyRaw)) && Number(legacyRaw) > 0 ? Number(legacyRaw) : null;
}

/** Fall back to dailyGoal when learnDailyGoal was never written. For learn: **new** cards per day when > 0. */
export function getLearnDailyGoal(dudoc: Record<string, unknown> | null | undefined): number {
    const legacy = Number(dudoc?.dailyGoal) || 0;
    const raw = dudoc?.learnDailyGoal;
    if (raw === undefined || raw === null || raw === '') {
        return legacy;
    }
    const n = parseInt(String(raw), 10);
    return !Number.isNaN(n) && n >= 0 ? n : legacy;
}
