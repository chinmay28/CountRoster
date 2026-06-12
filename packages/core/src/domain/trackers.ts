import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { Tracker, TrackerLink } from '../schema/tables.js';
import {
  trackerInputSchema,
  trackerPatchSchema,
  type TrackerInput,
  type TrackerLinkInput,
  type TrackerPatch,
} from '../schema/validators.js';
import { DerivedTrackerError } from './derived.js';

export interface TrackerService {
  create(input: TrackerInput): Promise<Tracker>;
  update(id: string, patch: TrackerPatch): Promise<Tracker>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  reorder(orderedIds: readonly string[]): Promise<void>;
  get(id: string): Promise<Tracker | null>;
  list(opts?: { includeArchived?: boolean; includeHidden?: boolean }): Promise<Tracker[]>;
  /** The source operands of a derived tracker, in order. Empty for ordinary ones. */
  links(trackerId: string): Promise<TrackerLink[]>;
  /** Replace a tracker's derivation operands (also toggles its derived flag). */
  setLinks(trackerId: string, links: readonly TrackerLinkInput[]): Promise<TrackerLink[]>;
}

export class TrackerNotFoundError extends Error {
  constructor(id: string) {
    super(`Tracker not found: ${id}`);
    this.name = 'TrackerNotFoundError';
  }
}

/**
 * Thrown when archiving or deleting a tracker that one or more derived trackers
 * still use as a source. The message names them so the user knows what to
 * remove first. (Archiving counts as removal here: an archived source would
 * leave its derivations silently depending on a tracker that's off the roster.)
 */
export class TrackerInUseError extends Error {
  constructor(
    readonly trackerId: string,
    readonly dependents: ReadonlyArray<{ id: string; name: string }>,
    action: 'archive' | 'delete' = 'delete',
  ) {
    const names = dependents.map((d) => `"${d.name}"`).join(', ');
    const plural = dependents.length === 1 ? '' : 's';
    const them = dependents.length === 1 ? 'it' : 'them';
    super(
      `Cannot ${action} this tracker: it is a source for derived tracker${plural} ` +
        `${names}. Delete or unlink ${them} first.`,
    );
    this.name = 'TrackerInUseError';
  }
}

export function createTrackerService(
  storage: Storage,
  clock: Clock,
): TrackerService {
  return new TrackerServiceImpl(storage, clock);
}

class TrackerServiceImpl implements TrackerService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async create(rawInput: TrackerInput): Promise<Tracker> {
    const input = trackerInputSchema.parse(rawInput);
    const id = newId();
    const now = this.clock.nowISO();
    const links = input.links ?? [];
    const isDerived = links.length > 0 ? 1 : 0;

    await this.storage.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO trackers (
          id, name, description, color, icon, kind, unit, target,
          reset_period, week_start, day_start_minute, default_value,
          archived_at, sort_order, is_derived, is_hidden, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.description ?? null,
          input.color,
          input.icon ?? null,
          input.kind,
          input.unit ?? null,
          input.target ?? null,
          input.reset_period,
          input.week_start,
          input.day_start_minute,
          input.default_value,
          input.sort_order,
          isDerived,
          input.is_hidden,
          now,
          now,
        ],
      );
      if (links.length > 0) await this.replaceLinks(tx, id, links, now, input.is_hidden);
    });

    const created = await this.get(id);
    if (!created) throw new Error(`Tracker insert succeeded but row not found: ${id}`);
    return created;
  }

  async update(id: string, rawPatch: TrackerPatch): Promise<Tracker> {
    const patch = trackerPatchSchema.parse(rawPatch);
    const existing = await this.get(id);
    if (!existing) throw new TrackerNotFoundError(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    const assign = <K extends keyof TrackerPatch>(key: K, column: string): void => {
      if (key in patch && patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        const v = patch[key];
        params.push(v === null ? null : (v as string | number));
      }
    };

    assign('name', 'name');
    assign('description', 'description');
    assign('color', 'color');
    assign('icon', 'icon');
    assign('kind', 'kind');
    assign('unit', 'unit');
    assign('target', 'target');
    assign('reset_period', 'reset_period');
    assign('week_start', 'week_start');
    assign('day_start_minute', 'day_start_minute');
    assign('default_value', 'default_value');
    assign('sort_order', 'sort_order');
    assign('is_hidden', 'is_hidden');

    // A supplied `links` list replaces the derivation wholesale and re-derives
    // the `is_derived` flag from whether any operands remain.
    const replacingLinks = 'links' in patch && patch.links !== undefined;
    if (replacingLinks) {
      sets.push('is_derived = ?');
      params.push(patch.links!.length > 0 ? 1 : 0);
    }

    if (sets.length === 0) return existing;

    // Flipping visibility must not split a derivation across the hidden
    // boundary; check against the operands this tracker keeps (replaced links
    // are validated in replaceLinks below) and against its dependents.
    const nextHidden = patch.is_hidden ?? existing.is_hidden;
    if (nextHidden !== existing.is_hidden) {
      await this.assertHiddenMatchesDerivations(id, nextHidden, {
        checkSources: !replacingLinks,
      });
    }

    const now = this.clock.nowISO();
    sets.push('updated_at = ?');
    params.push(now);
    params.push(id);

    await this.storage.transaction(async (tx) => {
      await tx.exec(`UPDATE trackers SET ${sets.join(', ')} WHERE id = ?`, params);
      if (replacingLinks) await this.replaceLinks(tx, id, patch.links!, now, nextHidden);
    });

    const updated = await this.get(id);
    if (!updated) throw new TrackerNotFoundError(id);
    return updated;
  }

  async archive(id: string): Promise<void> {
    // Archiving a source hides it from the roster while its derivations still
    // depend on it — treat it like deletion and block it the same way.
    await this.assertNotUsedAsSource(id, 'archive');
    const now = this.clock.nowISO();
    await this.storage.exec(
      `UPDATE trackers SET archived_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  async unarchive(id: string): Promise<void> {
    const now = this.clock.nowISO();
    await this.storage.exec(
      `UPDATE trackers SET archived_at = NULL, updated_at = ? WHERE id = ?`,
      [now, id],
    );
  }

  async delete(id: string): Promise<void> {
    // A tracker that feeds a derivation can't be deleted out from under it —
    // the derived tracker would silently lose an operand. Block with a clear,
    // named error so the user deletes the derived tracker(s) first. (Deleting a
    // derived tracker is fine: its own links cascade away.)
    await this.assertNotUsedAsSource(id, 'delete');

    // Permanent, unlike archive(). Entries, notes (and their edit log),
    // options, reminders, group memberships, and this tracker's own derivation
    // links cascade via ON DELETE CASCADE.
    await this.storage.exec(`DELETE FROM trackers WHERE id = ?`, [id]);
  }

  /** Throw TrackerInUseError if any derived tracker references `id` as a source. */
  private async assertNotUsedAsSource(
    id: string,
    action: 'archive' | 'delete',
  ): Promise<void> {
    const dependents = await this.storage.query<{ id: string; name: string }>(
      `SELECT DISTINCT t.id, t.name
         FROM tracker_links l
         JOIN trackers t ON t.id = l.tracker_id
        WHERE l.source_id = ?
        ORDER BY t.name ASC`,
      [id],
    );
    if (dependents.length > 0) throw new TrackerInUseError(id, dependents, action);
  }

  async reorder(orderedIds: readonly string[]): Promise<void> {
    const now = this.clock.nowISO();
    await this.storage.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.exec(
          `UPDATE trackers SET sort_order = ?, updated_at = ? WHERE id = ?`,
          [i, now, orderedIds[i]!],
        );
      }
    });
  }

  async get(id: string): Promise<Tracker | null> {
    const rows = await this.storage.query<Tracker>(
      `SELECT * FROM trackers WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(
    opts: { includeArchived?: boolean; includeHidden?: boolean } = {},
  ): Promise<Tracker[]> {
    const where: string[] = [];
    if (!opts.includeArchived) where.push('archived_at IS NULL');
    if (!opts.includeHidden) where.push('is_hidden = 0');
    const sql =
      `SELECT * FROM trackers` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY sort_order ASC, created_at ASC`;
    return this.storage.query<Tracker>(sql);
  }

  async links(trackerId: string): Promise<TrackerLink[]> {
    return this.storage.query<TrackerLink>(
      `SELECT * FROM tracker_links WHERE tracker_id = ?
        ORDER BY sort_order ASC, created_at ASC`,
      [trackerId],
    );
  }

  async setLinks(
    trackerId: string,
    links: readonly TrackerLinkInput[],
  ): Promise<TrackerLink[]> {
    const existing = await this.get(trackerId);
    if (!existing) throw new TrackerNotFoundError(trackerId);

    const now = this.clock.nowISO();
    await this.storage.transaction(async (tx) => {
      await tx.exec(
        `UPDATE trackers SET is_derived = ?, updated_at = ? WHERE id = ?`,
        [links.length > 0 ? 1 : 0, now, trackerId],
      );
      await this.replaceLinks(tx, trackerId, links, now, existing.is_hidden);
    });
    return this.links(trackerId);
  }

  /**
   * Throw DerivedTrackerError if giving `id` the visibility `hidden` would
   * split a derivation across the hidden boundary — i.e. any derived tracker
   * using it as a source (or, with `checkSources`, any of its own sources)
   * has the other visibility.
   */
  private async assertHiddenMatchesDerivations(
    id: string,
    hidden: 0 | 1,
    opts: { checkSources: boolean },
  ): Promise<void> {
    const dependents = await this.storage.query<{ name: string }>(
      `SELECT DISTINCT t.name
         FROM tracker_links l
         JOIN trackers t ON t.id = l.tracker_id
        WHERE l.source_id = ? AND t.is_hidden != ?`,
      [id, hidden],
    );
    if (dependents.length > 0) {
      throw new DerivedTrackerError(
        `Hidden and visible trackers cannot share a derivation: this tracker ` +
          `is a source for ${dependents.map((d) => `"${d.name}"`).join(', ')}.`,
      );
    }
    if (opts.checkSources) {
      const sources = await this.storage.query<{ name: string }>(
        `SELECT DISTINCT s.name
           FROM tracker_links l
           JOIN trackers s ON s.id = l.source_id
          WHERE l.tracker_id = ? AND s.is_hidden != ?`,
        [id, hidden],
      );
      if (sources.length > 0) {
        throw new DerivedTrackerError(
          `Hidden and visible trackers cannot share a derivation: this tracker ` +
            `is derived from ${sources.map((s) => `"${s.name}"`).join(', ')}.`,
        );
      }
    }
  }

  /**
   * Validate and (re)write a derived tracker's operands inside a transaction.
   * Each source must exist, be ordinary (no derived-of-derived nesting), not
   * be the tracker itself, and have the derived tracker's own visibility — a
   * derivation is either entirely hidden or entirely visible, never mixed.
   * Replaces any prior links.
   */
  private async replaceLinks(
    tx: Storage,
    trackerId: string,
    links: readonly TrackerLinkInput[],
    now: string,
    trackerHidden: 0 | 1,
  ): Promise<void> {
    await tx.exec(`DELETE FROM tracker_links WHERE tracker_id = ?`, [trackerId]);
    if (links.length === 0) return;

    // Reject duplicate sources up front — the table's UNIQUE constraint would
    // otherwise fail mid-insert with an opaque error.
    const seen = new Set<string>();
    for (const link of links) {
      if (link.source_id === trackerId) {
        throw new DerivedTrackerError('A derived tracker cannot reference itself.');
      }
      if (seen.has(link.source_id)) {
        throw new DerivedTrackerError(
          `Duplicate source tracker in derivation: ${link.source_id}`,
        );
      }
      seen.add(link.source_id);
    }

    const sources = await tx.query<{
      id: string;
      name: string;
      is_derived: number;
      is_hidden: number;
    }>(
      `SELECT id, name, is_derived, is_hidden FROM trackers
        WHERE id IN (${links.map(() => '?').join(', ')})`,
      links.map((l) => l.source_id),
    );
    const byId = new Map(sources.map((s) => [s.id, s]));
    for (const link of links) {
      const source = byId.get(link.source_id);
      if (!source) {
        throw new DerivedTrackerError(`Source tracker not found: ${link.source_id}`);
      }
      if (source.is_derived === 1) {
        throw new DerivedTrackerError(
          `A derived tracker cannot be a source of another derived tracker: ${link.source_id}`,
        );
      }
      if (source.is_hidden !== trackerHidden) {
        throw new DerivedTrackerError(
          `Hidden and visible trackers cannot share a derivation: source ` +
            `"${source.name}" is ${source.is_hidden ? 'hidden' : 'visible'} but ` +
            `the derived tracker is ${trackerHidden ? 'hidden' : 'visible'}.`,
        );
      }
    }

    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      await tx.exec(
        `INSERT INTO tracker_links
           (id, tracker_id, source_id, coefficient, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), trackerId, link.source_id, link.coefficient, i, now],
      );
    }
  }
}
