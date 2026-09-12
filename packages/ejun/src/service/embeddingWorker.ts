/**
 * Re-export shim for backwards-compatible import paths.
 *
 * The embedding index plumbing now lives in `@ejunz/ejunztools`
 * (`src/embedding/worker.ts`). This module stays in place so the existing
 * `ejun` and `ejunzworker` callers keep resolving `../service/embeddingWorker`
 * unchanged.
 */
export * from '@ejunz/ejunztools/src/embedding/worker';
