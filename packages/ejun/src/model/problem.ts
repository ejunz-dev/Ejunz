/**
 * Card practice problem helpers (normalize, kind switch, option slots).
 * Types live in `../interface` (`Problem`, etc.).
 */

import type {
    ProblemAiEval,
    ProblemAiEvalPoint,
    ProblemAiEvalSubPoint,
    Problem,
    ProblemAuthorNote,
    ProblemChain,
    ProblemChainRow,
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
import { nanoid } from 'nanoid';

const DEFAULT_OPTION_SLOTS = 4;
const MIN_SLOTS = 2;
const MAX_SLOTS = 8;
const AI_EVAL_POINT_MAX = 20;
const AI_EVAL_SUB_POINT_MAX = 12;
const AI_EVAL_SUB_POINT_ALIAS_MAX = 24;
const AI_EVAL_ALIAS_STR_MAX = 200;

const AUTHOR_NOTE_TEXT_MAX = 8000;
const AUTHOR_NOTE_MAX_ROWS = 32;

/** Normalize author notes from persisted JSON (editor / migrate). */
export function normalizeAuthorNotesFromRaw(raw: unknown): ProblemAuthorNote[] {
    if (!Array.isArray(raw)) return [];
    const out: ProblemAuthorNote[] = [];
    for (const x of raw) {
        if (!x || typeof x !== 'object') continue;
        const o = x as Record<string, unknown>;
        const text = typeof o.text === 'string' ? o.text.trim() : '';
        if (!text) continue;
        const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : nanoid();
        out.push({ id, text: text.slice(0, AUTHOR_NOTE_TEXT_MAX) });
        if (out.length >= AUTHOR_NOTE_MAX_ROWS) break;
    }
    return out;
}

/** Active author notes on a problem (for lesson / learn UI). */
export function getProblemAuthorNoteList(p: Problem): ProblemAuthorNote[] {
    return normalizeAuthorNotesFromRaw((p as Problem & { notes?: unknown }).notes);
}

function normalizeAiEvalPointScore(raw: unknown, fallback = 10): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : fallback;
    return Math.max(0, Math.min(1000, n));
}

function normalizeAiEvalAnswerAliases(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of raw) {
        if (typeof a !== 'string') continue;
        const t = a.trim();
        if (!t || t.length > AI_EVAL_ALIAS_STR_MAX) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= AI_EVAL_SUB_POINT_ALIAS_MAX) break;
    }
    return out;
}

function normalizeAiEvalSubPoints(raw: unknown, pointIndex: number): ProblemAiEvalSubPoint[] {
    const out: ProblemAiEvalSubPoint[] = [];
    if (!Array.isArray(raw)) return out;
    for (let j = 0; j < raw.length && out.length < AI_EVAL_SUB_POINT_MAX; j++) {
        const it = raw[j];
        if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
        const rec = it as Record<string, unknown>;
        const titleRaw = typeof rec.title === 'string' ? rec.title.trim() : '';
        const contentRaw = typeof rec.content === 'string' ? rec.content.trim() : '';
        const title = titleRaw || contentRaw;
        const content = contentRaw || titleRaw;
        if (!title || !content) continue;
        const idRaw = typeof rec.id === 'string' && rec.id.trim()
            ? rec.id.trim()
            : `pt_${pointIndex + 1}_sub_${j + 1}`;
        const answerAliases = normalizeAiEvalAnswerAliases(rec.answerAliases);
        const row: ProblemAiEvalSubPoint = {
            id: idRaw,
            title,
            content,
            score: normalizeAiEvalPointScore(rec.score, 10),
        };
        if (answerAliases.length) row.answerAliases = answerAliases;
        out.push(row);
    }
    return out;
}

function normalizeAiEvalPoints(raw: unknown): ProblemAiEvalPoint[] {
    const out: ProblemAiEvalPoint[] = [];
    if (!Array.isArray(raw)) return out;
    for (let i = 0; i < raw.length && out.length < AI_EVAL_POINT_MAX; i++) {
        const it = raw[i];
        if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
        const rec = it as Record<string, unknown>;
        const titleRaw = typeof rec.title === 'string' ? rec.title.trim() : '';
        const idRaw = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `pt_${i + 1}`;
        const subPoints = normalizeAiEvalSubPoints(rec.subPoints, i);
        if (!subPoints.length) continue;

        const title = titleRaw || `Point ${i + 1}`;
        out.push({
            id: idRaw,
            title,
            score: 0,
            subPoints,
        });
    }
    return out;
}

/** Max tags stored on a single problem (editor registry uses a higher cap). */
export const MAX_TAGS_PER_PROBLEM = 32;

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

export const CHAIN_ROW_MIN = 1;
export const CHAIN_ROW_MAX = 100;

function clampChainRowCount(n: unknown): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n as number) : CHAIN_ROW_MIN;
    return Math.min(CHAIN_ROW_MAX, Math.max(CHAIN_ROW_MIN, v));
}

/** Normalize chain rows from raw data. Rows with no rowType are kept as-is (undeclared). */
export function normalizeChainRows(raw: unknown): ProblemChainRow[] {
    if (!Array.isArray(raw)) return [{ rowType: 'flip', content: '' }];
    const count = clampChainRowCount(raw.length);
    return (raw as unknown[]).slice(0, count).map((x) => {
        if (!x || typeof x !== 'object') return {};
        const o = x as Record<string, unknown>;
        const content = typeof o.content === 'string' ? o.content : '';
        const rowType = o.rowType === 'text' ? 'text' : o.rowType === 'flip' ? 'flip' : undefined;
        return rowType ? { rowType, content } : { content: content || '' };
    });
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
        || t === 'chain'
        || t === 'ai_eval'
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

/**
 * Normalized tag list for a problem (`tags[]` only).
 */
export function getProblemTagList(
    p: (Partial<Problem> & { tags?: unknown }) | null | undefined,
): string[] {
    if (!p) return [];
    return sanitizeProblemTagRegistryList((p as { tags?: unknown }).tags, MAX_TAGS_PER_PROBLEM);
}

/** Normalize `raw.tags` when loading Mongo / JSON. */
export function normalizeProblemTagsFromRaw(raw: Record<string, unknown> | null | undefined): string[] {
    if (!raw) return [];
    return sanitizeProblemTagRegistryList(raw.tags, MAX_TAGS_PER_PROBLEM);
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

export function isChainProblem(p: Partial<Problem> | null | undefined): p is ProblemChain {
    return problemKind(p) === 'chain';
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

export function isAiEvalProblem(p: Partial<Problem> | null | undefined): p is ProblemAiEval {
    return problemKind(p) === 'ai_eval';
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
    const tagList = getProblemTagList(prev);
    const authorNotes = getProblemAuthorNoteList(prev);
    const common: ProblemCommon = {
        pid: prev.pid,
        analysis: prev.analysis,
        ...(typeof prev.title === 'string' ? { title: prev.title } : {}),
        ...(tagList.length ? { tags: tagList } : {}),
        ...(authorNotes.length ? { notes: authorNotes } : {}),
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
                        : isChainProblem(prev)
                          ? (((prev as ProblemChain).stem || '') || (prev as ProblemChain).rows.map((r) => r.content).join(' / '))
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
    if (newKind === 'ai_eval') {
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
                        : isChainProblem(prev)
                          ? (((prev as ProblemChain).stem || '') || (prev as ProblemChain).rows.map((r) => r.content).join(' / '))
                          : '';
        const points = normalizeAiEvalPoints((prev as { points?: unknown }).points);
        const passScoreRaw = (prev as { passScore?: unknown }).passScore;
        const maxAttemptsRaw = (prev as { maxAttempts?: unknown }).maxAttempts;
        const passScore = typeof passScoreRaw === 'number' && Number.isFinite(passScoreRaw)
            ? Math.max(0, Math.min(100, Math.round(passScoreRaw)))
            : 60;
        const maxAttempts = typeof maxAttemptsRaw === 'number' && Number.isFinite(maxAttemptsRaw)
            ? Math.max(1, Math.min(20, Math.round(maxAttemptsRaw)))
            : 3;
        return {
            ...common,
            type: 'ai_eval',
            stem,
            points,
            passScore,
            maxAttempts,
        };
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
        } else if (isChainProblem(prev)) {
            const ch = prev as ProblemChain;
            faceA = ch.rows[0]?.content ?? '';
            faceB = ch.rows.length > 1 ? ch.rows.slice(1).map((r) => r.content).join(' / ') : ch.analysis || '';
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
                        : isChainProblem(prev)
                          ? (((prev as ProblemChain).stem || '') || (prev as ProblemChain).rows.map((r) => String(r.content ?? '').trim()).filter(Boolean).join(' · '))
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
                        : isChainProblem(prev)
                          ? (((prev as ProblemChain).stem || '') || (prev as ProblemChain).rows.map((r) => String(r.content ?? '').trim()).filter(Boolean).join(' · '))
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
        if (isChainProblem(prev)) {
            const ch = prev as ProblemChain;
            const headers = ch.rows.map(() => '');
            const columns = ch.rows.map((r) => [r.content]);
            const headersPad = headers.length ? headers : [''];
            const colsPad = columns.length ? columns : [['']];
            const st = typeof ch.stem === 'string' && ch.stem.trim() !== '' ? { stem: ch.stem.trim() } : {};
            return { ...common, type: 'super_flip', headers: headersPad, columns: colsPad, ...st };
        }
        let stemS: string | undefined;
        if ('stem' in prev && typeof prev.stem === 'string' && prev.stem.trim()) stemS = prev.stem.trim();
        else if (isFlipProblem(prev)) stemS = prev.faceA || undefined;
        const colsEmpty = normalizeSuperFlipColumns([['']]);
        const stStem = stemS !== undefined ? { stem: stemS } : {};
        return { ...common, type: 'super_flip', headers: [''], columns: colsEmpty, ...stStem };
    }
    if (newKind === 'chain') {
        if (isChainProblem(prev)) {
            const ch = prev as ProblemChain;
            return { ...common, type: 'chain', rows: ch.rows.map((r) => ({ ...r })), ...(typeof ch.stem === 'string' && ch.stem.trim() !== '' ? { stem: ch.stem.trim() } : {}) };
        }
        const stemCh = 'stem' in prev && typeof prev.stem === 'string' && prev.stem.trim()
            ? prev.stem.trim()
            : isFlipProblem(prev)
              ? prev.faceA
              : isSuperFlipProblem(prev)
                ? (((prev as ProblemSuperFlip).stem || '').trim() || '')
                : '';
        const rows: ProblemChainRow[] = [];
        if (isSuperFlipProblem(prev)) {
            const { columns } = superFlipNormalized(prev as ProblemSuperFlip);
            const nrow = columns[0]?.length ?? 0;
            for (let r = 0; r < nrow; r++) {
                rows.push({ rowType: 'flip', content: columns.map((col) => String(col[r] ?? '')).join(' · ') });
            }
        } else if (isMatchingProblem(prev)) {
            const cols = matchingColumnsNormalized(prev);
            const nrow = cols[0]?.length ?? 0;
            for (let r = 0; r < nrow; r++) {
                rows.push({ rowType: 'flip', content: cols.map((col) => String(col[r] ?? '')).join(' · ') });
            }
        } else if (isFlipProblem(prev)) {
            rows.push({ rowType: 'text', content: prev.faceA });
            rows.push({ rowType: 'flip', content: prev.faceB });
        } else if (isFillBlankProblem(prev)) {
            rows.push({ rowType: 'flip', content: prev.stem });
            if (prev.answers?.length) {
                prev.answers.forEach((a) => rows.push({ rowType: 'flip', content: a }));
            }
        } else if ('stem' in prev && prev.stem) {
            rows.push({ rowType: 'flip', content: prev.stem });
        }
        if (!rows.length) rows.push({ rowType: 'flip', content: '' });
        return { ...common, type: 'chain', ...(stemCh ? { stem: stemCh } : {}), rows };
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
        if (isChainProblem(prev)) {
            const ch = prev as ProblemChain;
            const n = Math.max(2, ch.rows.length);
            const left = ch.rows.map((r) => r.content);
            const right = Array.from({ length: n }, () => '');
            const stemM = typeof ch.stem === 'string' && ch.stem.trim() !== '' ? ch.stem.trim() : undefined;
            const cols = normalizeMatchingColumns(undefined, left, right);
            return { ...common, type: 'matching', columns: cols, ...(stemM ? { stem: stemM } : {}), left: cols[0], right: cols[cols.length - 1] };
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
                    : isChainProblem(prev)
                      ? (((prev as ProblemChain).stem || '') || (prev as ProblemChain).rows.map((r) => String(r.content ?? '').trim()).filter(Boolean).join(' · '))
                      : '';
    let options = ['', '', '', ''];
    if ('options' in prev && Array.isArray(prev.options)) options = [...prev.options];
    else if (isMatchingProblem(prev)) options = [...matchingColumnsNormalized(prev).flat()];
    else if (isSuperFlipProblem(prev)) options = [...superFlipNormalized(prev).columns.flat()];
    else if (isChainProblem(prev)) options = (prev as ProblemChain).rows.map((r) => r.content);
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
    const tagsNorm = normalizeProblemTagsFromRaw(raw);
    const authorNotes = normalizeAuthorNotesFromRaw(raw.notes);
    const common: ProblemCommon = {
        pid,
        ...(typeof raw.analysis === 'string' ? { analysis: raw.analysis } : {}),
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(tagsNorm.length ? { tags: tagsNorm } : {}),
        ...(authorNotes.length ? { notes: authorNotes } : {}),
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
    if (t === 'ai_eval') {
        const stem = typeof raw.stem === 'string' ? raw.stem : '';
        const points = normalizeAiEvalPoints(raw.points);
        const passScoreRaw = typeof raw.passScore === 'number' && Number.isFinite(raw.passScore)
            ? Math.round(raw.passScore)
            : 60;
        const maxAttemptsRaw = typeof raw.maxAttempts === 'number' && Number.isFinite(raw.maxAttempts)
            ? Math.round(raw.maxAttempts)
            : 3;
        const passScore = Math.max(0, Math.min(100, passScoreRaw));
        const maxAttempts = Math.max(1, Math.min(20, maxAttemptsRaw));
        return {
            ...common,
            type: 'ai_eval',
            stem,
            points,
            passScore,
            maxAttempts,
        };
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
    if (t === 'chain') {
        const rows = normalizeChainRows(raw.rows);
        const stemS = typeof raw.stem === 'string' ? raw.stem.trim() : '';
        return { ...common, type: 'chain', rows, ...(stemS ? { stem: stemS } : {}) };
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

/** Scoring leaf: one row in AI rubric (top-level point or a sub-point). */
export type AiEvalRubricLeaf = {
    title: string;
    content: string;
    max: number;
    /** Index into {@link ProblemAiEval} `points` for order / grouping rules. */
    parentPointIndex: number;
    /** Parent group title only (loose match; may be empty). */
    parentTitle: string;
    /** Sub-point label as configured (loose match; may be empty). */
    subTitle: string;
    /** Stable id of the scored sub-point (learner answer slot key). */
    subPointId: string;
    /** Extra phrases that match like {@link #content} for loose gating. */
    answerAliases: string[];
};

/** Same normalization as lesson AI-eval gates (loose substring match). */
export function normalizeAiEvalMatchText(s: string): string {
    return String(s ?? '')
        .toLowerCase()
        .replace(/[\s,.;:!?'"`~@#$%^&*()\-_=+\[\]{}\\|/<>，。；：！？、（）《》【】“”‘’·…]+/g, '');
}

export function aiEvalContainsLoose(haystack: string, needle: string): boolean {
    const h = normalizeAiEvalMatchText(haystack);
    const n = normalizeAiEvalMatchText(needle);
    if (!h || !n) return false;
    return h.includes(n);
}

/**
 * Slot rubric match: answer contains the expected phrase, OR (Chinese-style) answer is a shorter
 * substring of the rubric phrase so omissions like 「箱子」→「箱」 still count as the same point.
 */
function aiEvalSlotPhraseMatches(slot: string, needle: string): boolean {
    if (aiEvalContainsLoose(slot, needle)) return true;
    const h = normalizeAiEvalMatchText(slot);
    const n = normalizeAiEvalMatchText(needle);
    if (!h || !n) return false;
    if (h.length < 2) return false;
    return n.includes(h);
}

/** Learner slot must loosely hit rubric {@link ProblemAiEvalSubPoint#content} or any {@link ProblemAiEvalSubPoint#answerAliases}. */
export function aiEvalSlotMatchesRubric(slotText: string, content: string, aliases: string[] | undefined): boolean {
    const slot = String(slotText ?? '').trim();
    if (!slot) return false;
    const needles = [String(content ?? '').trim(), ...(aliases ?? []).map((x) => String(x ?? '').trim())].filter(Boolean);
    for (const needle of needles) {
        if (aiEvalSlotPhraseMatches(slot, needle)) return true;
    }
    return false;
}

function aiEvalLooseFirstIndex(haystack: string, needle: string): number {
    const h = normalizeAiEvalMatchText(haystack);
    const n = normalizeAiEvalMatchText(needle);
    if (!n) return -1;
    return h.indexOf(n);
}

/** Like {@link aiEvalLooseFirstIndex}, but if the rubric phrase is not found, try dropping 1–2 trailing chars (learner shortenings). */
function aiEvalLooseFirstIndexRelaxed(haystack: string, needle: string): number {
    const idx = aiEvalLooseFirstIndex(haystack, needle);
    if (idx >= 0) return idx;
    const h = normalizeAiEvalMatchText(haystack);
    const n = normalizeAiEvalMatchText(needle);
    if (!h || !n || n.length < 3) return -1;
    for (let drop = 1; drop <= 2 && n.length - drop >= 2; drop++) {
        const truncated = n.slice(0, n.length - drop);
        const j = h.indexOf(truncated);
        if (j >= 0) return j;
    }
    return -1;
}

/**
 * First index in normalized answer for ordering: prefer content, then sub label, then full line title
 * (avoids using parent alone when several sub-points share one parent).
 */
function aiEvalLeafOrderAnchorPos(answerText: string, leaf: AiEvalRubricLeaf): number {
    const c = String(leaf.content ?? '').trim();
    const aliases = Array.isArray(leaf.answerAliases) ? leaf.answerAliases : [];
    const sub = String(leaf.subTitle ?? '').trim();
    const full = String(leaf.title ?? '').trim();
    const tries = [c, ...aliases.map((x) => String(x ?? '').trim()).filter(Boolean), sub, full].filter((x) => !!x);
    let best = Number.MAX_SAFE_INTEGER;
    for (const t of tries) {
        const idx = aiEvalLooseFirstIndexRelaxed(answerText, t);
        if (idx >= 0 && idx < best) best = idx;
    }
    return best;
}

/**
 * Top-level evaluation points ({@link ProblemAiEvalPoint} rows) must appear in rubric order.
 * Order between **sub-points inside the same parent** is not enforced.
 * Uses the earliest loose match among each parent's eligible leaves (content, then sub-title, then full title).
 *
 * @returns parent `points` indices whose entire group must score 0 due to order violation.
 */
export function aiEvalParentIndicesWithOrderViolation(
    leaves: AiEvalRubricLeaf[],
    eligible: boolean[],
    answerText: string,
): Set<number> {
    const bad = new Set<number>();
    if (!leaves.length || eligible.length !== leaves.length) return bad;

    const titlePos = (leaf: AiEvalRubricLeaf): number => aiEvalLeafOrderAnchorPos(answerText, leaf);

    const byParent = new Map<number, number[]>();
    for (let i = 0; i < leaves.length; i++) {
        const p = leaves[i].parentPointIndex;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p)!.push(i);
    }

    const maxParent = Math.max(...leaves.map((l) => l.parentPointIndex), 0);
    let lastParentFirst = -1;
    for (let p = 0; p <= maxParent; p++) {
        const idxs = byParent.get(p);
        if (!idxs) continue;
        let fp = Number.MAX_SAFE_INTEGER;
        for (const i of idxs) {
            if (!eligible[i]) continue;
            fp = Math.min(fp, titlePos(leaves[i]));
        }
        if (fp === Number.MAX_SAFE_INTEGER) continue;
        if (fp < lastParentFirst) bad.add(p);
        lastParentFirst = fp;
    }

    return bad;
}

/**
 * Flatten AI-eval rubric for scoring: only {@link ProblemAiEvalSubPoint} rows are scored;
 * the parent title prefixes each sub's display title.
 */
export function flattenAiEvalRubricForScoring(points: ProblemAiEvalPoint[]): AiEvalRubricLeaf[] {
    const pts = Array.isArray(points) ? points : [];
    const out: AiEvalRubricLeaf[] = [];
    for (let pi = 0; pi < pts.length; pi++) {
        const pt = pts[pi];
        const subs = Array.isArray(pt.subPoints) ? pt.subPoints : [];
        const nonEmptySubs = subs.filter((s) => {
            if (!s || typeof s !== 'object') return false;
            const t = String((s as ProblemAiEvalSubPoint).title ?? '').trim();
            const c = String((s as ProblemAiEvalSubPoint).content ?? '').trim();
            return !!(t || c);
        }) as ProblemAiEvalSubPoint[];
        const parentTitle = String(pt.title ?? '').trim();
        for (const s of nonEmptySubs) {
            const st = String(s.title ?? '').trim();
            const sc = String(s.content ?? '').trim();
            const title = st || sc;
            const content = sc || st;
            const max = typeof s.score === 'number' && Number.isFinite(s.score)
                ? Math.max(0, Math.round(s.score))
                : 0;
            const displayTitle = parentTitle ? `${parentTitle} · ${title}` : title;
            const subId = String((s as ProblemAiEvalSubPoint).id ?? '').trim()
                || `pt_${pi + 1}_sub_${out.length + 1}`;
            const answerAliases = normalizeAiEvalAnswerAliases((s as ProblemAiEvalSubPoint).answerAliases);
            out.push({
                title: displayTitle,
                content,
                max,
                parentPointIndex: pi,
                parentTitle,
                subTitle: st,
                subPointId: subId,
                answerAliases,
            });
        }
    }
    return out;
}

/** Sum of max scores over all rubric leaves (for UI totals). */
export function aiEvalRubricSumMax(points: ProblemAiEvalPoint[]): number {
    return flattenAiEvalRubricForScoring(points).reduce((a, x) => a + x.max, 0);
}

