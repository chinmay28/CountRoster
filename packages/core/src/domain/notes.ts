import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { Note, NoteEdit } from '../schema/tables.js';
import {
  noteInputSchema,
  notePatchSchema,
  type NoteInput,
  type NotePatch,
} from '../schema/validators.js';
import type { TimeRange } from './entries.js';

export interface NoteService {
  create(input: NoteInput): Promise<Note>;
  /**
   * Edit a note's body. The previous body is appended to `note_edits` as an
   * audit record — editing is non-destructive in the sense that you can
   * always see what the note used to say.
   */
  edit(id: string, newBody: string): Promise<Note>;
  /**
   * Patch a note's body and/or `occurred_at`. A body change is audit-logged
   * exactly like {@link edit}; an `occurred_at` change (re-dating a note) is
   * not, since it carries no prior content. No-ops when nothing changes.
   */
  update(id: string, patch: NotePatch): Promise<Note>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<Note | null>;
  /** Edit history for a note, oldest first. */
  history(noteId: string): Promise<NoteEdit[]>;
  forTracker(trackerId: string, range?: TimeRange): Promise<Note[]>;
}

export class NoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Note not found: ${id}`);
    this.name = 'NoteNotFoundError';
  }
}

export function createNoteService(
  storage: Storage,
  clock: Clock,
): NoteService {
  return new NoteServiceImpl(storage, clock);
}

class NoteServiceImpl implements NoteService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async create(rawInput: NoteInput): Promise<Note> {
    const input = noteInputSchema.parse(rawInput);
    const now = this.clock.nowISO();
    const id = newId();
    const occurredAt = input.occurred_at ?? now;

    await this.storage.exec(
      `INSERT INTO notes (id, tracker_id, entry_id, body, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.tracker_id, input.entry_id ?? null, input.body, occurredAt, now, now],
    );

    const created = await this.get(id);
    if (!created) throw new Error(`Note insert succeeded but row not found: ${id}`);
    return created;
  }

  async edit(id: string, newBody: string): Promise<Note> {
    if (typeof newBody !== 'string') throw new TypeError('body must be a string');
    return this.update(id, { body: newBody });
  }

  async update(id: string, rawPatch: NotePatch): Promise<Note> {
    const patch = notePatchSchema.parse(rawPatch);

    return this.storage.transaction(async (tx) => {
      const rows = await tx.query<Note>(
        `SELECT * FROM notes WHERE id = ?`,
        [id],
      );
      const existing = rows[0];
      if (!existing) throw new NoteNotFoundError(id);

      const bodyChanged = patch.body !== undefined && patch.body !== existing.body;
      const dateChanged =
        patch.occurred_at !== undefined && patch.occurred_at !== existing.occurred_at;

      // No-op if nothing actually changed.
      if (!bodyChanged && !dateChanged) return existing;

      const now = this.clock.nowISO();

      // Capture the previous body in the audit log (body edits only).
      if (bodyChanged) {
        await tx.exec(
          `INSERT INTO note_edits (id, note_id, prev_body, edited_at)
           VALUES (?, ?, ?, ?)`,
          [newId(), id, existing.body, now],
        );
      }

      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (bodyChanged) {
        sets.push('body = ?');
        params.push(patch.body!);
      }
      if (dateChanged) {
        sets.push('occurred_at = ?');
        params.push(patch.occurred_at!);
      }
      sets.push('updated_at = ?');
      params.push(now);
      params.push(id);

      await tx.exec(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, params);

      const updated = await tx.query<Note>(
        `SELECT * FROM notes WHERE id = ?`,
        [id],
      );
      return updated[0]!;
    });
  }

  async delete(id: string): Promise<void> {
    await this.storage.exec(`DELETE FROM notes WHERE id = ?`, [id]);
  }

  async get(id: string): Promise<Note | null> {
    const rows = await this.storage.query<Note>(
      `SELECT * FROM notes WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async history(noteId: string): Promise<NoteEdit[]> {
    return this.storage.query<NoteEdit>(
      `SELECT * FROM note_edits WHERE note_id = ?
       ORDER BY edited_at ASC, id ASC`,
      [noteId],
    );
  }

  async forTracker(trackerId: string, range: TimeRange = {}): Promise<Note[]> {
    const where: string[] = ['tracker_id = ?'];
    const params: (string | number)[] = [trackerId];
    // Compare by absolute instant (see EntryService.forTracker): occurred_at is
    // stored in the server's local offset, but range bounds may arrive in a
    // different offset, so lexical comparison is unsafe.
    if (range.start !== undefined) {
      where.push('julianday(occurred_at) >= julianday(?)');
      params.push(range.start);
    }
    if (range.end !== undefined) {
      where.push('julianday(occurred_at) < julianday(?)');
      params.push(range.end);
    }
    return this.storage.query<Note>(
      `SELECT * FROM notes WHERE ${where.join(' AND ')}
       ORDER BY occurred_at ASC, id ASC`,
      params,
    );
  }
}
