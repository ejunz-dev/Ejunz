/** Develop: knowledge base vs roadmap pool mode (domain user document). */

export type DevelopSourceMode = 'base' | 'roadmap';

export function normalizeDevelopMode(raw: unknown): DevelopSourceMode {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'roadmap') return 'roadmap';
    return 'base';
}

export function getDevelopMode(dudoc: Record<string, unknown> | null | undefined): DevelopSourceMode {
    return normalizeDevelopMode(dudoc?.developMode);
}

export function developPoolFieldForMode(mode: DevelopSourceMode): 'developPool' | 'developRoadmapPool' {
    return mode === 'roadmap' ? 'developRoadmapPool' : 'developPool';
}
