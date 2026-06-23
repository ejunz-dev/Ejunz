import { jsonrepair } from 'jsonrepair';

export function parseOperationPayload(raw: string): { operations?: unknown[] } | null {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(jsonrepair(raw));
    } catch {
      return null;
    }
  }
}

export function splitAiAssistantStream(accumulated: string): {
  visibleProse: string;
  inFence: boolean;
  fenceBody: string;
} {
  const openMatch = accumulated.match(/```(?:json)?\s*\n?/i);
  if (!openMatch || openMatch.index === undefined) {
    return { visibleProse: accumulated.trim(), inFence: false, fenceBody: '' };
  }
  const openStart = openMatch.index;
  const fenceStart = openStart + openMatch[0].length;
  const closeMatch = accumulated.slice(fenceStart).match(/\n?```/);
  if (!closeMatch || closeMatch.index === undefined) {
    const proseBefore = accumulated.slice(0, openStart).replace(/\s+$/u, '');
    return {
      visibleProse: proseBefore,
      inFence: true,
      fenceBody: accumulated.slice(fenceStart),
    };
  }
  const fenceBody = accumulated.slice(fenceStart, fenceStart + closeMatch.index);
  let afterClose = accumulated.slice(fenceStart + closeMatch.index + closeMatch[0].length);
  afterClose = afterClose.replace(/^[\r\n]*```\s*/, '');
  const proseBefore = accumulated.slice(0, openStart).replace(/\s+$/u, '');
  const visibleProse = [proseBefore, afterClose.trim()].filter(Boolean).join('\n').trim();
  return { visibleProse, inFence: false, fenceBody };
}

function extractNextJsonObject(s: string, start: number): { raw: string; next: number } | null {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (i >= s.length || s[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  const objStart = i;
  for (; i < s.length; i += 1) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inString) {
      if (c === '\\') esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = s.slice(objStart, i + 1);
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j += 1;
        if (j < s.length && s[j] === ',') j += 1;
        return { raw, next: j };
      }
    }
  }
  return null;
}

export function extractParsedOperationsFromPartialFence(fenceBody: string): unknown[] {
  const m = fenceBody.match(/"operations"\s*:\s*\[/);
  if (!m || m.index === undefined) return [];
  let pos = m.index + m[0].length;
  const out: unknown[] = [];
  while (true) {
    while (pos < fenceBody.length && /\s/.test(fenceBody[pos])) pos += 1;
    if (pos < fenceBody.length && fenceBody[pos] === ']') break;
    const ext = extractNextJsonObject(fenceBody, pos);
    if (!ext) break;
    try {
      const normalized = ext.raw
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, '\'')
        .replace(/,\s*([}\]])/g, '$1');
      let parsed: unknown;
      try {
        parsed = JSON.parse(normalized);
      } catch {
        parsed = JSON.parse(jsonrepair(normalized));
      }
      out.push(parsed);
    } catch {
      break;
    }
    pos = ext.next;
  }
  return out;
}

export function extractAiOperationTypesPartial(partial: string): string[] {
  const types: string[] = [];
  const re = /"type"\s*:\s*"([a-z_]+)"/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(partial)) !== null) {
    types.push(mm[1]);
  }
  return types;
}

export function friendlyRoadmapAiOperationLabel(type: string): string {
  const labels: Record<string, string> = {
    create_roadmap_node: 'Create roadmap node',
    update_roadmap_node: 'Update roadmap node',
    delete_roadmap_node: 'Delete roadmap node',
    create_roadmap_edge: 'Create roadmap edge',
    update_roadmap_edge: 'Update roadmap edge',
    delete_roadmap_edge: 'Delete roadmap edge',
    create_problem: 'Create problem',
  };
  return labels[type] || type;
}

export function summarizeRoadmapAiOperation(op: Record<string, unknown>): string {
  const t = String(op?.type || '');
  const short = (x: unknown, max = 16) => {
    const s = x != null ? String(x) : '';
    if (!s) return '—';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  switch (t) {
    case 'create_roadmap_node':
      return `Create ${short(op.kind || 'sub')} node "${short(op.text || op.label, 28)}" near ${short(op.relativeToNodeId || op.lane)}`;
    case 'update_roadmap_node':
      return `Update node ${short(op.nodeId)}`;
    case 'delete_roadmap_node':
      return `Delete node ${short(op.nodeId)}`;
    case 'create_roadmap_edge':
      return `Connect ${short(op.source)} → ${short(op.target)} (${short(op.lineStyle || 'solid')})`;
    case 'update_roadmap_edge':
      return `Update edge ${short(op.edgeId)}`;
    case 'delete_roadmap_edge':
      return `Delete edge ${short(op.edgeId)}`;
    case 'create_problem':
      return `Problem ${short(op.problemKind || 'single')} on node ${short(op.nodeId || op.cardId)}`;
    default:
      return t || '(unknown)';
  }
}
