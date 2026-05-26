import { uuidv7 } from 'uuidv7';

/**
 * Generate a UUIDv7 string. v7 IDs are timestamp-prefixed, so they sort by
 * creation time — useful for stable list ordering and (future) merge logic.
 */
export function newId(): string {
  return uuidv7();
}
