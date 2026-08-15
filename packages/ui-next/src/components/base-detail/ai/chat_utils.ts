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
