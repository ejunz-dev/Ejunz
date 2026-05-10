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
    ProblemSuperFlip,
    ProblemSingle,
    ProblemTrueFalse,
} from '../interface';

const DEFAULT_OPTION_SLOTS = 4;
const MIN_SLOTS = 2;
const MAX_SLOTS = 8;

/** Matching: row count editor + lesson bounds. */
export const MATCHING_PAIR_MIN = 2;
export const MATCHING_PAIR_MAX = 8;
/** Matching: minimum / maximum columns (lesson uses one independently shuffled dropdown pool per column). */
export const MATCHING_COL_MIN = 2;
export const MATCHING_COL_MAX = 8;

/** Super-flip: allow 1×1 … 8×8 (independent of matching’s ≥2 minimum). */
export const SUPER_FLIP_ROW_MIN = 1;
export const SUPER_FLIP_ROW_MAX = MATCHING_PAIR_MAX;
export const SUPER_FLIP_COL_MIN = 1;
export const SUPER_FLIP_COL_MAX = MATCHING_COL_MAX;

function clampSuperFlipRowCount(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n as number) : SUPER_FLIP_ROW_MIN;
    return Math.min(SUPER_FLIP_ROW_MAX, Math.max(SUPER_FLIP_ROW_MIN, v));
}

function clampSuperFlipColCount(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n as number) : SUPER_FLIP_COL_MIN;
    return Math.min(SUPER_FLIP_COL_MAX, Math.max(SUPER_FLIP_COL_MIN, v));
}

/** Column-major body for `super_flip`; allows single row/column (1×1). */
export function normalizeSuperFlipColumns(rawCols: unknown): string[][] {
    if (Array.isArray(rawCols) && rawCols.length >= SUPER_FLIP_COL_MIN) {
        const colCount = clampSuperFlipColCount(rawCols.length);
        const trimmed = (rawCols as unknown[]).slice(0, colCount).map((col) =>
            Array.isArray(col) ? (col as unknown[]).map((x) => String(x ?? '')) : [],
        );
        let rowCount = SUPER_FLIP_ROW_MIN;
        for (const col of trimmed) {
            rowCount = Math.max(rowCount, col.length);
        }
        rowCount = clampSuperFlipRowCount(rowCount);
        return trimmed.map((col) => {
            const padded = [...col];
            while (padded.length < rowCount) padded.push('');
            return padded.slice(0, rowCount);
        });
    }
    return [['']];
}

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

/** Build `columns[col][row]`; first/last columns mirror legacy `left` / `right`. */
export function normalizeMatchingColumns(rawCols: unknown, leftRaw?: unknown, rightRaw?: unknown): string[][] {
    if (Array.isArray(rawCols) && rawCols.length >= MATCHING_COL_MIN) {
        const colCount = Math.min(MATCHING_COL_MAX, Math.max(MATCHING_COL_MIN, rawCols.length));
        const trimmed = (rawCols as unknown[]).slice(0, colCount).map((col) =>
            Array.isArray(col) ? (col as unknown[]).map((x) => String(x ?? '')) : [],
        );
        let rowCount = MATCHING_PAIR_MIN;
        for (const col of trimmed) {
            rowCount = Math.max(rowCount, col.length);
        }
        rowCount = clampMatchingPairCount(rowCount);
        return trimmed.map((col) => {
            const padded = [...col];
            while (padded.length < rowCount) padded.push('');
            return padded.slice(0, rowCount);
        });
    }
    const { left, right } = parseMatchingSides(leftRaw, rightRaw);
    return [left, right];
}

export function matchingColumnsNormalized(p: Pick<ProblemMatching, 'columns' | 'left' | 'right'>): string[][] {
    return normalizeMatchingColumns(p.columns, p.left, p.right);
}

/** Headers + columns for super-flip tables (column-major body, same as matching). */
export function normalizeSuperFlipData(headersRaw: unknown, columnsRaw: unknown): { headers: string[]; columns: string[][] } {
    const columns = normalizeSuperFlipColumns(columnsRaw);
    const ncol = columns.length;
    const hList = Array.isArray(headersRaw) ? (headersRaw as unknown[]).map((x) => String(x ?? '')) : [];
    const headers = Array.from({ length: ncol }, (_, i) => String(hList[i] ?? ''));
    return { headers, columns };
}

export function superFlipNormalized(p: Pick<ProblemSuperFlip, 'headers' | 'columns'>): { headers: string[]; columns: string[][] } {
    return normalizeSuperFlipData(p.headers, p.columns);
}

/** Fallback stem text when converting from {@link ProblemSuperFlip} without `stem`. */
export function superFlipStemFallback(p: Pick<ProblemSuperFlip, 'stem' | 'headers' | 'columns'>): string {
    const st = typeof p.stem === 'string' ? p.stem.trim() : '';
    if (st) return st;
    const { headers, columns } = superFlipNormalized(p);
    const h = headers.map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ');
    if (h) return h;
    return (columns[0] || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ');
}

/** Learner picks original row index `i` per left row — one pick per selectable column (`selectableColCount`); correct iff identity on each column’s picks. */
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

/** `picksMatrix[row][col]` picks for column index `col` at row `row`; correct iff each column satisfies {@link matchingUserPicksCorrect}. */
export function matchingAllColumnsCorrect(
    pairCount: number,
    selectableColCount: number,
    picksMatrix: ReadonlyArray<ReadonlyArray<number | null | undefined>> | null | undefined,
): boolean {
    if (pairCount < MATCHING_PAIR_MIN || pairCount > MATCHING_PAIR_MAX) return false;
    if (selectableColCount < 1) return false;
    if (!picksMatrix || picksMatrix.length !== pairCount) return false;
    for (let k = 0; k < selectableColCount; k++) {
        const colPicks = picksMatrix.map((row) => row[k]);
        if (!matchingUserPicksCorrect(pairCount, colPicks)) return false;
    }
    return true;
}

export function problemKind(p: Partial<Problem> | null | undefined): ProblemKind {
    const t = (p as { type?: string } | null | undefined)?.type;
    if (
        t === 'multi'
        || t === 'true_false'
        || t === 'flip'
        || t === 'fill_blank'
        || t === 'matching'
        || t === 'super_flip'
    ) {
        return t;
    }
    return 'single';
}

export function clampOptionSlots(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n as number) : DEFAULT_OPTION_SLOTS;
    return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, v));
}

/** Trim; empty or case-insensitive `default` are treated as unset (not stored). */
export function normalizeProblemTagInput(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const v = raw.trim();
    if (!v || v.toLowerCase() === 'default') return undefined;
    return v.slice(0, 64);
}

/** Sanitize persisted tag registry payloads (dedupe preserve order). */
export function sanitizeProblemTagRegistryList(raw: unknown, maxEntries = 200): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of raw) {
        const t = normalizeProblemTagInput(x);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= maxEntries) break;
    }
    return out;
}

export function isMatchingProblem(p: Partial<Problem> | null | undefined): p is ProblemMatching {
    return problemKind(p) === 'matching';
}

export function isSuperFlipProblem(p: Partial<Problem> | null | undefined): p is ProblemSuperFlip {
    return problemKind(p) === 'super_flip';
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
    const rawTag = normalizeProblemTagInput((prev as { tag?: unknown }).tag);
    const common: ProblemCommon = {
        pid: prev.pid,
        analysis: prev.analysis,
        imageUrl: prev.imageUrl,
        imageNote: prev.imageNote,
        ...(typeof prev.title === 'string' ? { title: prev.title } : {}),
        ...(rawTag ? { tag: rawTag } : {}),
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
                      ? ((typeof prev.stem === 'string' && prev.stem.trim())
                          ? prev.stem.trim()
                          : (matchingColumnsNormalized(prev)[0] || []).join(' / '))
                      : isSuperFlipProblem(prev)
                        ? superFlipStemFallback(prev)
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
            const colsM = matchingColumnsNormalized(prev);
            faceA = (colsM[0] || []).join(' / ');
            faceB = (colsM[colsM.length - 1] || []).join(' / ');
        } else if (isSuperFlipProblem(prev)) {
            const colsM = superFlipNormalized(prev).columns;
            faceA = (colsM[0] || []).join(' / ');
            faceB = (colsM[colsM.length - 1] || []).join(' / ');
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
                          : (matchingColumnsNormalized(prev)[0] || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')
                      )
                      : isSuperFlipProblem(prev)
                        ? superFlipStemFallback(prev)
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
                          : (matchingColumnsNormalized(prev)[0] || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')
                      )
                      : isSuperFlipProblem(prev)
                        ? superFlipStemFallback(prev)
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
    if (newKind === 'super_flip') {
        if (isSuperFlipProblem(prev)) {
            const sf = prev as ProblemSuperFlip;
            const { headers, columns } = superFlipNormalized(sf);
            const st = typeof sf.stem === 'string' && sf.stem.trim() !== '' ? { stem: sf.stem.trim() } : {};
            return {
                ...common,
                type: 'super_flip',
                headers: [...headers],
                columns: columns.map((c) => [...c]),
                ...st,
            };
        }
        if (isMatchingProblem(prev)) {
            const cols = matchingColumnsNormalized(prev);
            const headers = cols.map(() => '');
            const st = typeof prev.stem === 'string' && prev.stem.trim() !== '' ? { stem: prev.stem.trim() } : {};
            return {
                ...common,
                type: 'super_flip',
                headers,
                columns: cols.map((c) => [...c]),
                ...st,
            };
        }
        let stemS: string | undefined;
        if ('stem' in prev && typeof prev.stem === 'string' && prev.stem.trim()) stemS = prev.stem.trim();
        else if (isFlipProblem(prev)) stemS = prev.faceA || undefined;
        const colsEmpty = normalizeSuperFlipColumns([['']]);
        const stStem = stemS !== undefined ? { stem: stemS } : {};
        return { ...common, type: 'super_flip', headers: [''], columns: colsEmpty, ...stStem };
    }
    if (newKind === 'matching') {
        if (isSuperFlipProblem(prev)) {
            const sf = prev as ProblemSuperFlip;
            const { columns } = superFlipNormalized(sf);
            const norm = normalizeMatchingColumns(columns);
            const st = typeof sf.stem === 'string' && sf.stem.trim() !== '' ? { stem: sf.stem.trim() } : {};
            const left = norm[0];
            const right = norm[norm.length - 1];
            return { ...common, type: 'matching', columns: norm, left, right, ...st };
        }
        if (isMatchingProblem(prev)) {
            const cols = matchingColumnsNormalized(prev);
            const st = typeof prev.stem === 'string' && prev.stem.trim() !== '' ? { stem: prev.stem.trim() } : {};
            const left = cols[0];
            const right = cols[cols.length - 1];
            return { ...common, type: 'matching', columns: cols, ...st, left, right };
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
        const cols = normalizeMatchingColumns(undefined, sidesPick.left, sidesPick.right);
        const left = cols[0];
        const right = cols[cols.length - 1];
        return { ...common, type: 'matching', columns: cols, ...stOut, left, right };
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
                      : (matchingColumnsNormalized(prev)[0] || []).map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')
                  )
                  : isSuperFlipProblem(prev)
                    ? superFlipStemFallback(prev)
                    : '';
    let options = ['', '', '', ''];
    if ('options' in prev && Array.isArray(prev.options)) options = [...prev.options];
    else if (isMatchingProblem(prev)) options = [...matchingColumnsNormalized(prev).flat()];
    else if (isSuperFlipProblem(prev)) options = [...superFlipNormalized(prev).columns.flat()];
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
    const tagNorm = normalizeProblemTagInput(raw.tag);
    const common: ProblemCommon = {
        pid,
        ...(typeof raw.analysis === 'string' ? { analysis: raw.analysis } : {}),
        ...(typeof raw.imageUrl === 'string' ? { imageUrl: raw.imageUrl } : {}),
        ...(typeof raw.imageNote === 'string' ? { imageNote: raw.imageNote } : {}),
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(tagNorm ? { tag: tagNorm } : {}),
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
        const columns = normalizeMatchingColumns(raw.columns, raw.left, raw.right);
        const stemM = typeof raw.stem === 'string' ? raw.stem.trim() : '';
        const left = columns[0];
        const right = columns[columns.length - 1];
        return {
            ...common,
            type: 'matching',
            ...(stemM ? { stem: stemM } : {}),
            columns,
            left,
            right,
        };
    }
    if (t === 'super_flip') {
        const { headers, columns } = normalizeSuperFlipData(raw.headers, raw.columns);
        const stemS = typeof raw.stem === 'string' ? raw.stem.trim() : '';
        return {
            ...common,
            type: 'super_flip',
            headers,
            columns,
            ...(stemS ? { stem: stemS } : {}),
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

