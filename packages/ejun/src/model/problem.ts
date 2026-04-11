/**
 * Card practice problem helpers (normalize, kind switch, option slots).
 * Types live in `../interface` (`Problem`, etc.).
 */

import type {
    Problem,
    ProblemCommon,
    ProblemFlip,
    ProblemKind,
    ProblemMulti,
    ProblemSingle,
    ProblemTrueFalse,
} from '../interface';

const DEFAULT_OPTION_SLOTS = 4;
const MIN_SLOTS = 2;
const MAX_SLOTS = 8;

export function clampOptionSlots(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_OPTION_SLOTS;
    return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, v));
}

export function problemKind(p: Partial<Problem> | null | undefined): ProblemKind {
    const t = (p as { type?: string } | null)?.type;
    if (t === 'multi' || t === 'true_false' || t === 'flip') return t;
    return 'single';
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
    };
    const slots = clampOptionSlots(
        isMultiProblem(prev) || problemKind(prev) === 'single'
            ? (prev as ProblemSingle | ProblemMulti).optionSlots
                ?? (prev as ProblemSingle | ProblemMulti).options?.length
            : DEFAULT_OPTION_SLOTS,
    );
    if (newKind === 'flip') {
        let faceA = '';
        let faceB = '';
        if (isFlipProblem(prev)) {
            faceA = prev.faceA;
            faceB = prev.faceB;
        } else if ('stem' in prev) {
            faceA = prev.stem || '';
            faceB = prev.analysis || '';
        }
        return { ...common, type: 'flip', faceA, faceB };
    }
    if (newKind === 'true_false') {
        const stem = 'stem' in prev ? prev.stem : isFlipProblem(prev) ? prev.faceA : '';
        let ans: 0 | 1 = 1;
        if (isTrueFalseProblem(prev)) ans = prev.answer;
        else if (problemKind(prev) === 'single' && 'answer' in prev) ans = prev.answer >= 1 ? 1 : 0;
        return { ...common, type: 'true_false', stem, answer: ans };
    }
    if (newKind === 'multi') {
        const stem = 'stem' in prev ? prev.stem : isFlipProblem(prev) ? prev.faceA : '';
        let options: string[] = ['', '', '', ''];
        if ('options' in prev && Array.isArray(prev.options)) options = [...prev.options];
        options = ensureOptionArrayLength(options, slots);
        let answer: number[] = [0];
        if (isMultiProblem(prev)) answer = normalizeMultiAnswers(prev.answer);
        else if (problemKind(prev) === 'single' && 'answer' in prev) {
            answer = [Math.min(options.length - 1, Math.max(0, prev.answer))];
        }
        return { ...common, type: 'multi', stem, options, answer, optionSlots: slots };
    }
    const stem = 'stem' in prev ? prev.stem : isFlipProblem(prev) ? prev.faceA : '';
    let options = ['', '', '', ''];
    if ('options' in prev && Array.isArray(prev.options)) options = [...prev.options];
    options = ensureOptionArrayLength(options, slots);
    let answer = 0;
    if (problemKind(prev) === 'single' && 'answer' in prev) {
        answer = Math.min(options.length - 1, Math.max(0, prev.answer));
    } else if (isMultiProblem(prev) && prev.answer.length) {
        answer = Math.min(options.length - 1, Math.max(0, prev.answer[0]));
    } else if (isTrueFalseProblem(prev)) answer = prev.answer;
    return { ...common, type: 'single', stem, options, answer, optionSlots: slots };
}

export function migrateRawProblem(raw: Record<string, unknown>): Problem {
    const pid = typeof raw.pid === 'string' && raw.pid ? raw.pid : `p_${Date.now()}`;
    const common: ProblemCommon = {
        pid,
        ...(typeof raw.analysis === 'string' ? { analysis: raw.analysis } : {}),
        ...(typeof raw.imageUrl === 'string' ? { imageUrl: raw.imageUrl } : {}),
        ...(typeof raw.imageNote === 'string' ? { imageNote: raw.imageNote } : {}),
    };
    const t = raw.type;
    if (t === 'flip') {
        const faceA = typeof raw.faceA === 'string' ? raw.faceA : typeof raw.stem === 'string' ? raw.stem : '';
        const faceB = typeof raw.faceB === 'string' ? raw.faceB : typeof raw.analysis === 'string' ? raw.analysis : '';
        return { ...common, type: 'flip', faceA, faceB };
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
