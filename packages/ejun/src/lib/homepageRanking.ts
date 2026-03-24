/**
 * Homepage leaderboards: CS2-style rating (≈1.0 typical, up to ~2.0).
 * Raw domain stats align with profile-style counts (nodes / cards / problems).
 */
import type { Db } from 'mongodb';
import { coll, TYPE_BASE, TYPE_CARD, TYPE_NODE } from '../model/document';

export interface DomainStatRow {
    uid: number;
    nodes: number;
    cards: number;
    problems: number;
}

/** Full leaderboard row after rating + ordering (for cache / API). */
export interface RankedStatRow extends DomainStatRow {
    rating: number;
    rank: number;
}

function countNodesInBaseDoc(baseDoc: {
    nodes?: Array<{ id?: string }>;
    branchData?: Record<string, { nodes?: Array<{ id?: string }> }>;
}): number {
    const nodeIds = new Set<string>();
    if (baseDoc.nodes && Array.isArray(baseDoc.nodes)) {
        for (const node of baseDoc.nodes) {
            if (node?.id) nodeIds.add(node.id);
        }
    }
    if (baseDoc.branchData && typeof baseDoc.branchData === 'object') {
        for (const branch of Object.keys(baseDoc.branchData)) {
            const branchNodes = baseDoc.branchData[branch]?.nodes;
            if (branchNodes && Array.isArray(branchNodes)) {
                for (const node of branchNodes) {
                    if (node?.id) nodeIds.add(node.id);
                }
            }
        }
    }
    return nodeIds.size;
}

type Acc = { nodes: number; cards: number; problems: number };

function mergeStat(map: Map<number, Acc>, uid: number, patch: Partial<Acc>) {
    if (!uid) return;
    const cur = map.get(uid) || { nodes: 0, cards: 0, problems: 0 };
    map.set(uid, {
        nodes: cur.nodes + (patch.nodes ?? 0),
        cards: cur.cards + (patch.cards ?? 0),
        problems: cur.problems + (patch.problems ?? 0),
    });
}

/** Per-user contribution in one domain (TYPE_NODE + base node inventory + TYPE_CARD/problems). */
export async function aggregateContributionByUser(domainId: string): Promise<DomainStatRow[]> {
    const map = new Map<number, Acc>();

    const nodeAgg = await coll.aggregate<{ _id: number; c: number }>([
        { $match: { domainId, docType: TYPE_NODE, owner: { $gt: 0 } } },
        { $group: { _id: '$owner', c: { $sum: 1 } } },
    ]).toArray();
    for (const row of nodeAgg) mergeStat(map, row._id, { nodes: row.c });

    const cardAgg = await coll.aggregate<{ _id: number; cards: number; problems: number }>([
        { $match: { domainId, docType: TYPE_CARD, owner: { $gt: 0 } } },
        {
            $group: {
                _id: '$owner',
                cards: { $sum: 1 },
                problems: { $sum: { $size: { $ifNull: ['$problems', []] } } },
            },
        },
    ]).toArray();
    for (const row of cardAgg) {
        mergeStat(map, row._id, { cards: row.cards, problems: row.problems });
    }

    const bases = await coll
        .find(
            { domainId, docType: TYPE_BASE, owner: { $gt: 0 } },
            { projection: { owner: 1, nodes: 1, branchData: 1 } },
        )
        .toArray();
    for (const b of bases) {
        const n = countNodesInBaseDoc(b as any);
        if (n > 0) mergeStat(map, (b as any).owner, { nodes: n });
    }

    return Array.from(map.entries())
        .map(([uid, { nodes, cards, problems }]) => ({ uid, nodes, cards, problems }))
        .filter((r) => r.nodes > 0 || r.cards > 0 || r.problems > 0);
}

/** Per-user consumption in one domain from learn_consumption_stats (same source as profile consumption). */
export async function aggregateConsumptionByUser(db: Db, domainId: string): Promise<DomainStatRow[]> {
    const rows = await db.collection('learn_consumption_stats').aggregate<{
        _id: number;
        nodes: number;
        cards: number;
        problems: number;
    }>([
        { $match: { domainId } },
        {
            $group: {
                _id: '$userId',
                nodes: { $sum: { $ifNull: ['$nodes', 0] } },
                cards: { $sum: { $ifNull: ['$cards', 0] } },
                problems: { $sum: { $ifNull: ['$problems', 0] } },
            },
        },
    ]).toArray();

    return rows
        .map((r) => ({
            uid: r._id,
            nodes: r.nodes || 0,
            cards: r.cards || 0,
            problems: r.problems || 0,
        }))
        .filter((row) => row.nodes > 0 || row.cards > 0 || row.problems > 0);
}

function enrichSortAndRank(rows: DomainStatRow[]): RankedStatRow[] {
    const ratingMap = computeRatingMap(rows);
    const enriched = rows.map((r) => ({
        ...r,
        rating: ratingMap.get(r.uid) ?? 1,
    }));
    enriched.sort((a, b) => computeStatScore(b) - computeStatScore(a));
    return enriched.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Build full contribution leaderboard (expensive; prefer cached reads on homepage). */
export async function buildSortedContributionRows(domainId: string): Promise<RankedStatRow[]> {
    const rows = await aggregateContributionByUser(domainId);
    return enrichSortAndRank(rows);
}

/** Build full consumption leaderboard (expensive; prefer cached reads on homepage). */
export async function buildSortedConsumptionRows(db: Db, domainId: string): Promise<RankedStatRow[]> {
    const rows = await aggregateConsumptionByUser(db, domainId);
    return enrichSortAndRank(rows);
}

/** Raw score: log-scale blend (cards/problems weighted slightly higher than nodes). */
export function computeStatScore(row: DomainStatRow): number {
    return (
        Math.log10(1 + row.nodes)
        + Math.log10(1 + row.cards) * 1.15
        + Math.log10(1 + row.problems) * 1.1
    );
}

/**
 * Map each uid to a rating in [0.5, 2.0], mean ≈ 1.0 for typical domains.
 * Uses z-score with a floor on σ so small domains don't explode.
 */
export function computeRatingMap(rows: DomainStatRow[]): Map<number, number> {
    const ratingMap = new Map<number, number>();
    if (!rows.length) return ratingMap;

    const scored = rows.map((r) => ({ r, raw: computeStatScore(r) }));
    const positives = scored.filter((x) => x.raw > 0);
    if (!positives.length) {
        for (const { r } of scored) ratingMap.set(r.uid, 1);
        return ratingMap;
    }

    const vals = positives.map((x) => x.raw);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1e-9;
    const stdFloor = Math.max(std, mean * 0.08);

    for (const { r, raw } of scored) {
        if (raw <= 0) {
            ratingMap.set(r.uid, 1);
            continue;
        }
        const z = (raw - mean) / stdFloor;
        let rating = 1 + 0.38 * z;
        rating = Math.max(0.5, Math.min(2, rating));
        ratingMap.set(r.uid, Math.round(rating * 100) / 100);
    }
    return ratingMap;
}
