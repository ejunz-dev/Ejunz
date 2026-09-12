import { BaseModel } from 'ejun/src/model/base';
import { MAX_NODES_PER_CALL } from '../../catalog';
import { asText } from '../shared';
import type { BaseNode } from 'ejun/src/interface';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedUpdate {
    index: number;
    nodeId: string;
    update: Partial<BaseNode> & { nodeId: string };
    fields: string[];
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { nodeId, text?, parentId? }');
    if (raw.length > MAX_NODES_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_NODES_PER_CALL}; split the work across calls`);
    }

    const planned: PlannedUpdate[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with nodeId`);
        const fields = entry as Record<string, unknown>;
        const nodeId = asText(fields.nodeId);
        if (!nodeId) throw new Error(`entries[${index}].nodeId is required`);
        if (seen.has(nodeId)) throw new Error(`entries[${index}].nodeId ${nodeId} appears twice; send one entry per node`);
        seen.add(nodeId);

        const update: Partial<BaseNode> & { nodeId: string } = { nodeId };
        const changed: string[] = [];
        if (Object.prototype.hasOwnProperty.call(fields, 'text')) {
            if (typeof fields.text !== 'string') throw new Error(`entries[${index}].text must be a string`);
            update.text = fields.text;
            changed.push('text');
        }
        if (Object.prototype.hasOwnProperty.call(fields, 'parentId')) {
            const parentId = asText(fields.parentId);
            if (!parentId) throw new Error(`entries[${index}].parentId is required when provided`);
            update.parentId = parentId;
            changed.push('parentId');
        }
        if (!changed.length) throw new Error(`entries[${index}] names nothing to change; give text, parentId, or both`);
        planned.push({ index, nodeId, update, fields: changed });
    }

    await BaseModel.applyNodeUpdates(ctx.domainId, ctx.baseDocId, planned.map((entry) => entry.update));

    return {
        ok: true,
        baseId: ctx.baseDocId,
        nodeCount: planned.length,
        nodes: planned.map((entry) => ({
            index: entry.index,
            nodeId: entry.nodeId,
            changed: entry.fields,
            ...entry.update,
        })),
        reads: 1,
        writes: 1,
    };
}
