import { existsSync } from 'node:fs'

// The hook installer is repository-only tooling; published packages omit src/.
const installer = new URL('../src/script/install-lefthook.mjs', import.meta.url)
if (existsSync(installer)) await import(installer.href)
