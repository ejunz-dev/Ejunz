/**
 * Card practice problem helpers (normalize, kind switch, option slots).
 * Types live in `../interface` (`Problem`, etc.).
 */

import type {
    Problem,
    ProblemCommon,
    ProblemFillBlank,
    ProblemFlip,
    ProblemKind,
    ProblemMatching,
    ProblemMulti,
    ProblemSingle,
    ProblemTrueFalse,
} from '../interface';

const DEFAULT_OPTION_SLOTS = 4;
const MIN_SLOTS = 2;
const MAX_SLOTS = 8;

/** Matching pairs: lesson UI uses this range. */
export const MATCHING_PAIR_MIN = 2;
export const MATCHING_PAIR_MAX = 8;

export function clampMatchingPairCount(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n as number) : MATCHING_PAIR_MIN;
    return Math.min(MATCHING_PAIR_MAX, Math.max(MATCHING_PAIR_MIN, v));
}

/** Equal-length padded sides for storage (n between MIN–MAX inclusive). */
export function parseMatchingSides(leftRaw: unknown, rightRaw: unknown): Pick<ProblemMatching, 'left' | 'right'> {
    const toArr = (raw: unknown): string[] =>
        Array.isArray(raw) ? (raw as unknown[]).map((x) => String(x ?? '')) : [];
    let left = toArr(leftRaw);
    let right = toArr(rightRaw);
    const n = clampMatchingPairCount(Math.max(left.length, right.length));
    while (left.length < n) left.push('');
    while (right.length < n) right.push('');
    return { left: left.slice(0, n), right: right.slice(0, n) };
}

/** Learner picks original right-column index per left row `i`; correct iff each pick is identity i. */
export function matchingUserPicksCorrect(pairCount: number, picks: Array<number | null | undefined>): boolean {
    if (pairCount < MATCHING_PAIR_MIN || pairCount > MATCHING_PAIR_MAX) return false;
    if (!picks || picks.length !== pairCount) return false;
    const seen = new Set<number>();
    for (let i = 0; i < pairCount; i++) {
        const jRaw = picks[i];
        const j = typeof jRaw === 'number' && Number.isFinite(jRaw) ? Math.trunc(jRaw as number) : NaN;
        if (!Number.isFinite(j) || j < 0 || j >= pairCount || seen.has(j)) return false;
        seen.add(j);
        if (j !== i) return false;
    }
    return seen.size === pairCount;
}

export function problemKind(p: Partial<Problem> | null | undefined): ProblemKind {
    const t = (p as { type?: string } | null | undefined)?.type;
    if (
        t === 'multi'
        || t === 'true_false'
        || t === 'flip'
        || t === 'fill_blank'
        || t === 'matching'
    ) {
        return t;
    }
    return 'single';
}

export function clampOptionSlots(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n as number) : DEFAULT_OPTION_SLOTS;
    return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, v));
}

export function isMatchingProblem(p: Partial<Problem> | null | undefined): p is ProblemMatching {
    return problemKind(p) === 'matching';
}

export function isFlipProblem(p: Partial<Problem> | null | undefined): p is ProblemFlip {
    return problemKind(p) === 'flip';
}

export function isTrueFalseProblem(p: Partial<Problem> | null | undefined): p is ProblemTrueFalse {
    return problemKind(p) === 'true_false';
}

export function isMultiProblem(p: Partial<Problem> | null | undefined): p is ProblemMulti {
    return problemKind(p) === 'multi';
}

export function isFillBlankProblem(p: Partial<Problem> | null | undefined): p is ProblemFillBlank {
    return problemKind(p) === 'fill_blank';
}

/** Count of blanks: `___` markers in stem, or 1 if none. */
export function fillBlankSlotCount(stem: string): number {
    const occ = (String(stem).match(/___/g) || []).length;
    return Math.max(1, occ);
}

export function syncFillBlankAnswersLen(prev: string[], n: number): string[] {
    const next = [...prev];
    while (next.length < n) next.push('');
    return next.slice(0, n);
}

export function normalizeFillBlankText(s: string): string {
    return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function fillBlankResponseMatches(expected: string[], user: string[]): boolean {
    const n = expected.length;
    if (n !== user.length) return false;
    for (let i = 0; i < n; i++) {
        if (normalizeFillBlankText(expected[i]) !== normalizeFillBlankText(user[i])) return false;
    }
    return true;
}

/** Non-empty option texts with stable original indices (for shuffled display mapping). */
export function visibleOptionOriginalIndices(options: string[] | null | undefined): number[] {
    const o = options || [];
    return o.map((t, i) => ({ t: String(t ?? '').trim(), i })).filter((x) => x.t.length > 0).map((x) => x.i);
}

export function normalizeMultiAnswers(raw: unknown): number[] {
    if (Array.isArray(raw)) {
        const xs = raw.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
        return [...new Set(xs.map((n) => Math.trunc(n)))].sort((a, b) => a - b);
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) return [Math.trunc(raw)];
    return [0];
}

export function setsEqualAsSorted(a: number[], b: number[]): boolean {
    const sa = [...a].sort((x, y) => x - y);
    const sb = [...b].sort((x, y) => x - y);
    if (sa.length !== sb.length) return false;
    return sa.every((v, i) => v === sb[i]);
}

export function ensureOptionArrayLength(options: string[], slots: number): string[] {
    const n = clampOptionSlots(slots);
    const next = [...options];
    while (next.length < n) next.push('');
    if (next.length > n) return next.slice(0, n);
    return next;
}

export function problemChangeKind(prev: Problem, newKind: ProblemKind): Problem {
    const common: ProblemCommon = {
        pid: prev.pid,
        analysis: prev.analysis,
        imageUrl: prev.imageUrl,
        imageNote: prev.imageNote,
        ...(typeof prev.title === 'string' ? { title: prev.title } : {}),
    };
    const slots = clampOptionSlots(
        isMultiProblem(prev) || problemKind(prev) === 'single'
            ? (prev as ProblemSingle | ProblemMulti).optionSlots
                ?? (prev as ProblemSingle | ProblemMulti).options?.length
            : DEFAULT_OPTION_SLOTS,
    );
    if (newKind === 'fill_blank') {
        const stem =
            'stem' in prev && typeof prev.stem === 'string'
                ? prev.stem
                : isFlipProblem(prev)
                  ? prev.faceA
                  : isFillBlankProblem(prev)
                    ? prev.stem
                    : isMatchingProblem(prev)
                      ? ((typeof prev.stem === 'string' && prev.stem.trim()) ? prev.stem : (prev.left || []).join(' / '))
                      : '';
        const n = fillBlankSlotCount(stem);
        let answers = Array.from({ length: n }, () => '');
        if (isFillBlankProblem(prev)) {
            answers = syncFillBlankAnswersLen(prev.answers, n);
        } else if (problemKind(prev) === 'single' && 'options' in prev && typeof prev.answer === 'number') {
            const t = prev.options[prev.answer];
            if (typeof t === 'string' && t.trim()) answers[0] = t;
        } else if (isMultiProblem(prev) && prev.answer?.length) {
            const opts = prev.options || [];
            const want = normalizeMultiAnswers(prev.answer);
            want.slice(0, n).forEach((idx, i) => {
                const t = opts[idx];
                if (typeof t === 'string') answers[i] = t;
            });
        } else if (isTrueFalseProblem(prev)) {
            answers[0] = prev.answer === 1 ? 'true' : 'false';
        }
        return { ...common, type: 'fill_blank', stem, answers };
    }
    if (newKind === 'flip') {
        let faceA = '';
        let faceB = '';
        if (isFlipProblem(prev)) {
            faceA = prev.faceA;
            faceB = prev.faceB;
        } else if (isMatchingProblem(prev)) {
            faceA = (prev.left || []).join(' / ');
            faceB = (prev.right || []).join(' / ');
        } else if (isFillBlankProblem(prev)) {
            faceA = prev.stem || '';
            faceB = (prev.answers || []).join(' / ');
        } else if ('stem' in prev) {
            faceA = prev.stem || '';
            faceB = prev.analysis || '';
        }
        const hintFlip =
            isFlipProblem(prev) && typeof prev.hint === 'string' && prev.hint.trim()
                ? { hint: prev.hint.trim() }
                : {};
        return { ...common, type: 'flip', faceA, faceB, ...hintFlip };
    }
    if (newKind === 'true_false') {
        const stem =
            'stem' in prev && typeof prev.stem === 'string'
                ? prev.stem
                : isFlipProblem(prev)
                  ? prev.faceA
                  : isFillBlankProblem(prev)
                    ? prev.stem
                    : isMatchingProblem(prev)
                      ? ((typeof prev.stem === 'string' && prev.stem.trim())
                          ? prev.stem
                          : (prev.left || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')
                      )
                      : '';
        let ans: 0 | 1 = 1;
        if (isTrueFalseProblem(prev)) ans = prev.answer;
        else if (problemKind(prev) === 'single') {
            const a = (prev as ProblemSingle).answer;
            if (typeof a === 'number') ans = a >= 1 ? 1 : 0;
        }
        return { ...common, type: 'true_false', stem, answer: ans };
    }
    if (newKind === 'multi') {
        const stem =
            'stem' in prev && typeof prev.stem === 'string'
                ? prev.stem
                : isFlipProblem(prev)
                  ? prev.faceA
                  : isFillBlankProblem(prev)
                    ? prev.stem
                    : isMatchingProblem(prev)
                      ? ((typeof prev.stem === 'string' && prev.stem.trim())
                          ? prev.stem
                          : (prev.left || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')
                      )
                      : '';
        let options: string[] = ['', '', '', ''];
        if ('options' in prev && Array.isArray(prev.options)) options = [...prev.options];
        options = ensureOptionArrayLength(options, slots);
        let answer: number[] = [0];
        if (isMultiProblem(prev)) answer = normalizeMultiAnswers(prev.answer);
        else if (problemKind(prev) === 'single') {
            const a = (prev as ProblemSingle).answer;
            if (typeof a === 'number') answer = [Math.min(options.length - 1, Math.max(0, a))];
        }
        return { ...common, type: 'multi', stem, options, answer, optionSlots: slots };
    }
    if (newKind === 'matching') {
        if (isMatchingProblem(prev)) {
            const sides = parseMatchingSides(prev.left, prev.right);
            const st = typeof prev.stem === 'string' && prev.stem.trim() !== '' ? { stem: prev.stem.trim() } : {};
            return { ...common, type: 'matching', ...st, ...sides };
        }
        let stemM: string | undefined;
        if ('stem' in prev && typeof prev.stem === 'string' && prev.stem.trim()) stemM = prev.stem.trim();
        else if (isFlipProblem(prev)) stemM = prev.faceA || undefined;
        else if (isFillBlankProblem(prev)) stemM = prev.stem || undefined;

        let sidesPick = parseMatchingSides(['', ''], ['', '']);

        if (problemKind(prev) === 'single' || isMultiProblem(prev)) {
            const pm = prev as ProblemSingle | ProblemMulti;
            const rawOpts = Array.isArray(pm.options) ? [...pm.options] : [];
            while (rawOpts.length < 4) rawOpts.push('');
            sidesPick = parseMatchingSides(rawOpts.slice(0, 2), rawOpts.slice(2, 4));
        } else if (isFillBlankProblem(prev)) {
            const ans = [...(prev.answers || [])];
            while (ans.length < 4) ans.push('');
            sidesPick = parseMatchingSides(ans.slice(0, 2), ans.slice(2, 4));
        } else if (isFlipProblem(prev)) {
            sidesPick = parseMatchingSides([prev.faceA], [prev.faceB]);
        }

        const stOut = stemM !== undefined ? { stem: stemM } : {};
        return { ...common, type: 'matching', ...stOut, ...sidesPick };
    }
    const stem =
        'stem' in prev && typeof prev.stem === 'string'
            ? prev.stem
            : isFlipProblem(prev)
              ? prev.faceA
              : isFillBlankProblem(prev)
                ? prev.stem
                : isMatchingProblem(prev)
                  ? ((typeof prev.stem === 'string' && prev.stem.trim())
                      ? prev.stem
                      : (prev.left || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')
                  )
                  : '';
    let options = ['', '', '', ''];
    if ('options' in prev && Array.isArray(prev.options)) options = [...prev.options];
    else if (isMatchingProblem(prev)) options = [...(prev.left || []), ...(prev.right || [])];
    options = ensureOptionArrayLength(options, slots);
    let answer = 0;
    if (problemKind(prev) === 'single') {
        const a = (prev as ProblemSingle).answer;
        if (typeof a === 'number') answer = Math.min(options.length - 1, Math.max(0, a));
    } else if (isMultiProblem(prev) && prev.answer.length) {
        answer = Math.min(options.length - 1, Math.max(0, prev.answer[0]));
    } else if (isTrueFalseProblem(prev)) answer = prev.answer;
    else if (isFillBlankProblem(prev) && prev.answers?.[0]) {
        const idx = options.findIndex((o) => normalizeFillBlankText(o) === normalizeFillBlankText(prev.answers[0]));
        if (idx >= 0) answer = idx;
    }
    return { ...common, type: 'single', stem, options, answer, optionSlots: slots };
}

export function migrateRawProblem(raw: Record<string, unknown>): Problem {
    const pid = typeof raw.pid === 'string' && raw.pid ? raw.pid : `p_${Date.now()}`;
    const common: ProblemCommon = {
        pid,
        ...(typeof raw.analysis === 'string' ? { analysis: raw.analysis } : {}),
        ...(typeof raw.imageUrl === 'string' ? { imageUrl: raw.imageUrl } : {}),
        ...(typeof raw.imageNote === 'string' ? { imageNote: raw.imageNote } : {}),
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    };
    const t = raw.type;
    if (t === 'flip') {
        const faceA = typeof raw.faceA === 'string' ? raw.faceA : typeof raw.stem === 'string' ? raw.stem : '';
        const faceB = typeof raw.faceB === 'string' ? raw.faceB : typeof raw.analysis === 'string' ? raw.analysis : '';
        const hintFlip = typeof raw.hint === 'string' && raw.hint.trim() ? raw.hint.trim() : undefined;
        return { ...common, type: 'flip', faceA, faceB, ...(hintFlip ? { hint: hintFlip } : {}) };
    }
    if (t === 'true_false') {
        const stem = typeof raw.stem === 'string' ? raw.stem : '';
        const a = raw.answer === 1 || raw.answer === true ? 1 : 0;
        return { ...common, type: 'true_false', stem, answer: a as 0 | 1 };
    }
    if (t === 'multi') {
        const stem = typeof raw.stem === 'string' ? raw.stem : '';
        const options = Array.isArray(raw.options) ? (raw.options as unknown[]).map((x) => String(x ?? '')) : ['', '', '', ''];
        const slots = clampOptionSlots(raw.optionSlots ?? options.length);
        const answer = normalizeMultiAnswers(raw.answer);
        return {
            ...common,
            type: 'multi',
            stem,
            options: ensureOptionArrayLength(options, slots),
            answer,
            optionSlots: slots,
        };
    }
    if (t === 'fill_blank') {
        const stem = typeof raw.stem === 'string' ? raw.stem : '';
        const n = fillBlankSlotCount(stem);
        const answers = syncFillBlankAnswersLen(
            Array.isArray(raw.answers) ? (raw.answers as unknown[]).map((x) => String(x ?? '')) : [''],
            n,
        );
        return { ...common, type: 'fill_blank', stem, answers };
    }
    if (t === 'matching') {
        const sides = parseMatchingSides(raw.left, raw.right);
        const stemM = typeof raw.stem === 'string' ? raw.stem.trim() : '';
        return {
            ...common,
            type: 'matching',
            ...(stemM ? { stem: stemM } : {}),
            ...sides,
        };
    }
    const stem = typeof raw.stem === 'string' ? raw.stem : '';
    const options = Array.isArray(raw.options) ? (raw.options as unknown[]).map((x) => String(x ?? '')) : ['', '', '', ''];
    const slots = clampOptionSlots(raw.optionSlots ?? options.length);
    const ans = typeof raw.answer === 'number' && Number.isFinite(raw.answer) ? Math.trunc(raw.answer) : 0;
    const filled = ensureOptionArrayLength(options, slots);
    return {
        ...common,
        type: 'single',
        stem,
        options: filled,
        answer: Math.max(0, Math.min(filled.length - 1, ans)),
        optionSlots: slots,
    };
}
