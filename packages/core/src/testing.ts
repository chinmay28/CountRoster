/**
 * Test-only exports. Importing from `@countroster/core/testing` pulls in
 * `better-sqlite3`, which is a native Node module — production mobile and
 * web builds should never import from this path.
 */
export { MemoryAdapter } from './storage/memory.js';
