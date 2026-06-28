/** Develop: knowledge base pool mode (domain user document). Always 'base'. */

export type DevelopSourceMode = 'base';

export function normalizeDevelopMode(_raw: unknown): DevelopSourceMode {
    return 'base';
}

export function getDevelopMode(_dudoc: Record<string, unknown> | null | undefined): DevelopSourceMode {
    return 'base';
}

export function developPoolFieldForMode(_mode: DevelopSourceMode): 'developPool' {
    return 'developPool';
}
