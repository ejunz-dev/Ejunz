import { BaseModel } from 'ejun/src/model/base';
import * as document from 'ejun/src/model/document';
import type { CardDoc } from 'ejun/src/interface';
import { buildEmbeddingStatusView, loadEmbeddingIndexSnapshot } from '../../embedding/worker';
import type { ToolContext, ToolArgs } from '../../types';

const MAX_SAMPLE_IDS = 20;

function summarize(text: string, max = 96): string {
    const flat = (text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cardHasIndexableText(card: CardDoc): boolean {
    return !!(
        (card.title || '').trim()
        || (card.content || '').trim()
        || (card.problems || []).length
    );
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);

    const [state, snapshot, cardDocs] = await Promise.all([
        buildEmbeddingStatusView(ctx.domainId, ctx.baseDocId),
        loadEmbeddingIndexSnapshot(ctx.domainId, ctx.baseDocId),
        document.getMulti(ctx.domainId, document.TYPE_CARD, { baseDocId: ctx.baseDocId })
            .toArray() as Promise<CardDoc[]>,
    ]);

    const liveNodes = new Map<string, string>();
    for (const node of base.nodes || []) {
        const text = (node.text || '').trim();
        if (text) liveNodes.set(node.id, text);
    }

    const missingNodes: { nodeId: string; text: string }[] = [];
    const staleNodes: { nodeId: string; text: string }[] = [];
    for (const [nodeId, text] of liveNodes) {
        const indexed = snapshot.nodes.get(nodeId);
        if (!indexed) missingNodes.push({ nodeId, text: summarize(text) });
        else if (indexed.text !== text) staleNodes.push({ nodeId, text: summarize(text) });
    }
    const orphanNodeIds = [...snapshot.nodes.keys()].filter((nodeId) => !liveNodes.has(nodeId));

    const missingCards: { cardId: string; nodeId: string; title: string }[] = [];
    const detachedCards: { cardId: string; nodeId: string; title: string }[] = [];
    const staleCards: { cardId: string; title: string; cardUpdatedAt: Date; indexedAt: Date }[] = [];
    const liveCardIds = new Set<string>();
    let emptyCards = 0;
    let indexableCards = 0;
    for (const card of cardDocs) {
        const cardId = String(card.docId);
        liveCardIds.add(cardId);
        if (!cardHasIndexableText(card)) {
            emptyCards++;
            continue;
        }
        indexableCards++;
        const indexed = snapshot.cards.get(cardId);
        if (!indexed) {
            const entry = { cardId, nodeId: card.nodeId, title: card.title || '' };
            if (liveNodes.has(card.nodeId)) missingCards.push(entry);
            else detachedCards.push(entry);
            continue;
        }
        if (card.updateAt && indexed.updatedAt < card.updateAt) {
            staleCards.push({
                cardId,
                title: card.title || '',
                cardUpdatedAt: card.updateAt,
                indexedAt: indexed.updatedAt,
            });
        }
    }
    const orphanCards = [...snapshot.cards.entries()]
        .filter(([cardId]) => !liveCardIds.has(cardId))
        .map(([cardId, held]) => ({ cardId, title: held.title }));

    const indexedNodes = [...liveNodes.keys()].filter((nodeId) => snapshot.nodes.has(nodeId)).length;

    return {
        ok: true,
        baseId: base.docId,
        baseTitle: base.title || '',
        state: {
            status: state.status,
            mode: state.mode,
            generation: state.generation,
            appliedGeneration: state.appliedGeneration,
            pendingWork: state.generation > state.appliedGeneration,
            progress: state.progress,
            indexedCount: state.indexedCount,
            lastError: state.lastError,
            updatedAt: state.updatedAt,
        },
        stored: {
            vectors: snapshot.vectors,
            nodeVectors: snapshot.nodeVectors,
            cardVectors: snapshot.cardVectors,
            cardCount: snapshot.cardCount,
            models: snapshot.models,
            dimensions: snapshot.dimensions,
            oldestUpdatedAt: snapshot.oldestUpdatedAt,
            newestUpdatedAt: snapshot.newestUpdatedAt,
        },
        coverage: {
            nodes: {
                live: liveNodes.size,
                indexed: indexedNodes,
                missing: missingNodes.length,
                stale: staleNodes.length,
                orphan: orphanNodeIds.length,
            },
            cards: {
                live: cardDocs.length,
                indexable: indexableCards,
                indexed: indexableCards - missingCards.length - detachedCards.length,
                missing: missingCards.length,
                detached: detachedCards.length,
                stale: staleCards.length,
                orphan: orphanCards.length,
                empty: emptyCards,
            },
        },
        samples: {
            missingNodes: missingNodes.slice(0, MAX_SAMPLE_IDS),
            staleNodes: staleNodes.slice(0, MAX_SAMPLE_IDS),
            orphanNodeIds: orphanNodeIds.slice(0, MAX_SAMPLE_IDS),
            missingCards: missingCards.slice(0, MAX_SAMPLE_IDS),
            detachedCards: detachedCards.slice(0, MAX_SAMPLE_IDS),
            staleCards: staleCards.slice(0, MAX_SAMPLE_IDS),
            orphanCards: orphanCards.slice(0, MAX_SAMPLE_IDS),
        },
    };
}
