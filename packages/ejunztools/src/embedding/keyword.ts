/**
 * Keyword matching for semantic search.
 *
 * Kept free of the embedding model, Mongo, and the `ejun` runtime so the scoring
 * behaviour can be exercised on its own.
 */

/** The parts of a stored document the keyword matcher reads. */
export interface KeywordDocument {
    kind: 'node' | 'card';
    text: string;
    cardTitle?: string;
}

/** Bounded keyword contribution, plus the query terms that produced it. */
export interface KeywordMatch {
    keywordScore: number;
    matchedTerms: string[];
}

/** A query term paired with its compiled matcher, built once per query. */
export interface TermMatcher {
    term: string;
    re: RegExp;
}

/** CJK ideographs, kana, and hangul: scripts that are not whitespace-delimited. */
export const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
/** Cap on the CJK bigram terms one query may contribute. */
export const MAX_CJK_TERMS = 24;

/**
 * Ceiling for the whole keyword component, so it can reorder near-ties without
 * outweighing the cosine term.
 */
export const KEYWORD_SCORE_CAP = 0.4;
export const KEYWORD_TITLE_WEIGHT = 0.6;
export const KEYWORD_NODE_BODY_WEIGHT = 0.4;
export const KEYWORD_CARD_BODY_WEIGHT = 0.3;
export const KEYWORD_PHRASE_BONUS = 0.05;
/** Share of the keyword score that comes from term coverage, not hit quality. */
export const KEYWORD_COVERAGE_SHARE = 0.75;
/** Weight of the keyword component in the final blended score. */
export const KEYWORD_BLEND = 0.25;

/**
 * Fold a value into the normalised form the matchers compare against.
 *
 * @param value Raw query, title, or body text; may be empty.
 * @returns NFKC-normalised, lower-cased text.
 */
export function normalizeKeywordText(value: string): string {
    return (value || '').normalize('NFKC').toLowerCase();
}

/**
 * Extract the terms a query can be matched on.
 *
 * ASCII words are matched on token boundaries; CJK text has none, so every CJK
 * run contributes its overlapping bigrams. Single CJK characters are too common
 * to be a signal, and the cap keeps a long Chinese sentence from producing so
 * many terms that the coverage ratio below stops discriminating.
 *
 * @param query Raw user query.
 * @returns De-duplicated terms, ASCII terms first.
 */
export function extractKeywordTerms(query: string): string[] {
    const normalized = normalizeKeywordText(query);
    const terms: string[] = [];

    const raw = normalized.match(/[a-z0-9][a-z0-9._/-]*/g) || [];
    const ignored = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with']);
    for (const term of raw) {
        const clean = term.replace(/^[/._-]+|[/._-]+$/g, '');
        if (!clean || ignored.has(clean)) continue;
        if (clean.length === 1) continue;
        if (clean.length === 2 && /^[a-z]+$/.test(clean) && !['ai', 'go', 'js'].includes(clean)) continue;
        if (!terms.includes(clean)) terms.push(clean);
    }

    let cjkTerms = 0;
    for (const run of normalized.match(CJK_RUN_RE) || []) {
        for (let i = 0; i + 2 <= run.length && cjkTerms < MAX_CJK_TERMS; i++) {
            const bigram = run.slice(i, i + 2);
            if (terms.includes(bigram)) continue;
            terms.push(bigram);
            cjkTerms++;
        }
    }

    return terms;
}

/**
 * Compile one term into its matcher.
 *
 * @param term A term from `extractKeywordTerms`.
 * @returns The term with its compiled boundary-aware matcher.
 */
export function toTermMatcher(term: string): TermMatcher {
    return { term, re: termRegex(term) };
}

/**
 * Build the boundary-aware matcher for one term.
 *
 * @param term Term to match; matched case-insensitively between non-alphanumerics.
 * @returns The compiled regular expression.
 */
export function termRegex(term: string): RegExp {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

/**
 * Constrain a value to the unit interval.
 *
 * @param value Candidate score; may be negative, NaN, or above 1.
 * @returns The value clamped to [0, 1], with non-finite input mapped to 0.
 */
export function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Score how well one document matches a query.
 *
 * The result is graded: more matched terms score higher, a title hit outscores a
 * body hit, and adjacent-term phrases add a bonus. The previous implementation
 * summed those weights and then clamped with `Math.min(0.35, score)`, which
 * pinned every matching node to exactly 0.35 and every matching card to exactly
 * 0.18 — a constant offset that carried no ranking information at all.
 *
 * `coverage` measures how much of the query was matched and `quality` how good
 * those hits were; both are in (0, 1], so the sum stays bounded without a cliff.
 *
 * @param matchers Compiled query terms, in query order.
 * @param doc The stored node or card being scored.
 * @returns The bounded score and the terms that matched.
 */
export function scoreKeywordMatch(matchers: TermMatcher[], doc: KeywordDocument): KeywordMatch {
    if (!matchers.length) return { keywordScore: 0, matchedTerms: [] };
    const title = normalizeKeywordText(doc.cardTitle || '');
    const text = normalizeKeywordText(doc.text || '');
    const bodyWeight = doc.kind === 'node' ? KEYWORD_NODE_BODY_WEIGHT : KEYWORD_CARD_BODY_WEIGHT;
    const matchedTerms: string[] = [];
    let weight = 0;

    for (const { term, re } of matchers) {
        const inTitle = !!title && re.test(title);
        const inText = !!text && re.test(text);
        if (!inTitle && !inText) continue;
        matchedTerms.push(term);
        if (inTitle) weight += KEYWORD_TITLE_WEIGHT;
        if (inText) weight += bodyWeight;
    }
    if (!matchedTerms.length) return { keywordScore: 0, matchedTerms };

    let phraseHits = 0;
    for (let i = 0; i < matchers.length - 1; i++) {
        const phrase = `${matchers[i].term} ${matchers[i + 1].term}`;
        if ((text && text.includes(phrase)) || (title && title.includes(phrase))) phraseHits++;
    }

    const coverage = matchedTerms.length / matchers.length;
    const quality = weight / (matchedTerms.length * (KEYWORD_TITLE_WEIGHT + bodyWeight));
    const raw = coverage * KEYWORD_COVERAGE_SHARE
        + quality * (1 - KEYWORD_COVERAGE_SHARE)
        + phraseHits * KEYWORD_PHRASE_BONUS;

    return { keywordScore: KEYWORD_SCORE_CAP * Math.min(1, raw), matchedTerms };
}
