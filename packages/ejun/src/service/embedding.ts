/**
 * Re-export shim for backwards-compatible import paths.
 *
 * The embedding service implementation now lives in `@ejunz/ejunztools`
 * (`src/embedding/service.ts`). This module stays in place so the existing
 * `ejun` callers — `entry/worker.ts`, `service/bus.ts`, `model/agent.ts`,
 * `handler/base.ts` — keep resolving `../service/embedding` unchanged.
 */
export * from '@ejunz/ejunztools/src/embedding/service';
export { default } from '@ejunz/ejunztools/src/embedding/service';
