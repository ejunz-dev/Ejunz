/**
 * Single-statement worker entry that boots `runWorkerSession` on the real
 * `parentPort`. The engine module stays import-safe on the host thread; this
 * entry is the only module that assumes a worker thread.
 * @module @ejunz/ea-core/workflow-worker-thread/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { requireParentPort, runWorkerSession } from './worker-thread.ts'
import type { WorkerInit } from './worker-thread.ts'

// workerData is `any` at the node:worker_threads boundary; the engine is the
// only spawner and always provides a WorkerInit.
void runWorkerSession(requireParentPort(parentPort), workerData as WorkerInit)
