import type { SessionRecordDoc } from '../model/record';

/** Shared by record detail page and develop contribution wall. */
export function buildDevelopRecordDetailAugment(
    rdoc: SessionRecordDoc,
    translate: (k: string) => string,
): { developChangeRows: Array<{ opLabel: string; detail: string }>; developCountSummaries: string[] } {
    const developChangeRows: Array<{ opLabel: string; detail: string }> = [];
    const developCountSummaries: string[] = [];
    if (rdoc.recordKind === 'develop_save' && rdoc.developMeta?.changeLines?.length) {
        for (const line of rdoc.developMeta.changeLines) {
            developChangeRows.push({
                opLabel: translate(`record_develop_op_${line.op}`),
                detail: line.label || '',
            });
        }
    } else if (rdoc.recordKind === 'develop_save' && rdoc.developMeta) {
        const m = rdoc.developMeta;
        const add = (n: number, key: string) => {
            if (n > 0) developCountSummaries.push(translate(key).replace(/\{0\}/g, String(n)));
        };
        add(m.nodeCreates, 'record_develop_count_node_create');
        add(m.nodeUpdates, 'record_develop_count_node_update');
        add(m.nodeDeletes, 'record_develop_count_node_delete');
        add(m.cardCreates, 'record_develop_count_card_create');
        add(m.cardUpdates, 'record_develop_count_card_update');
        add(m.cardDeletes, 'record_develop_count_card_delete');
        add(m.edgeCreates, 'record_develop_count_edge_create');
        add(m.edgeDeletes, 'record_develop_count_edge_delete');
    }
    return { developChangeRows, developCountSummaries };
}

export function developSaveRecordSummaryLines(rdoc: SessionRecordDoc, translate: (k: string) => string): string[] {
    const { developChangeRows, developCountSummaries } = buildDevelopRecordDetailAugment(rdoc, translate);
    const lines: string[] = [];
    for (const row of developChangeRows) {
        const d = String(row.detail || '').trim();
        lines.push(d ? `${row.opLabel}: ${d}` : row.opLabel);
    }
    lines.push(...developCountSummaries);
    if (lines.length === 0) {
        lines.push(translate('record_develop_changes_empty'));
    }
    return lines;
}
