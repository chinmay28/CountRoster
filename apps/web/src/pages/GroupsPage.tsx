import { useState } from 'react';
import type { Tracker, TrackerGroup } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import {
  SortableList,
  DragHandle,
  type SortableHandleProps,
} from '../components/SortableList.tsx';

/** Create groups and organize trackers into them. */
export function GroupsPage() {
  const core = useCore();
  const { data, loading, error, reload } = useAsync(async () => {
    const [groups, trackers] = await Promise.all([
      core.groups.list(),
      core.trackers.list(),
    ]);
    const members = new Map<string, Tracker[]>();
    await Promise.all(
      groups.map(async (g) => {
        members.set(g.id, await core.groups.trackersIn(g.id));
      }),
    );
    return { groups, trackers, members };
  }, []);

  const [name, setName] = useState('');
  const [color, setColor] = useState('#4ECDC4');
  const [busy, setBusy] = useState(false);

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await core.groups.create({ name: name.trim(), color, sort_order: 0 });
      setName('');
      reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading groups…</p>;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return null;

  return (
    <section className="form-page">
      <h1 className="page-title">Groups</h1>
      <p className="muted">
        Organize your trackers into groups. Grouped trackers are shown under
        their group heading on the home screen.
      </p>

      <form className="groups__create" onSubmit={createGroup}>
        <input
          type="text"
          placeholder="New group name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Group name"
        />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          aria-label="Group color"
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
          Add group
        </button>
      </form>

      {data.groups.length === 0 && <p className="muted">No groups yet.</p>}

      {data.groups.length > 1 && (
        <p className="muted groups__hint">Drag the ⠿ handle to reorder groups.</p>
      )}

      <SortableList
        items={data.groups}
        className="groups__list"
        onReorder={async (orderedGroupIds) => {
          await core.groups.reorder(orderedGroupIds);
          reload();
        }}
        renderItem={(g, handleProps) => (
          <GroupCard
            group={g}
            members={data.members.get(g.id) ?? []}
            allTrackers={data.trackers}
            onChanged={reload}
            dragHandleProps={handleProps}
          />
        )}
      />
    </section>
  );
}

function GroupCard({
  group,
  members,
  allTrackers,
  onChanged,
  dragHandleProps,
}: {
  group: TrackerGroup;
  members: Tracker[];
  allTrackers: Tracker[];
  onChanged: () => void;
  dragHandleProps: SortableHandleProps;
}) {
  const core = useCore();
  const [busy, setBusy] = useState(false);
  const [toAdd, setToAdd] = useState('');
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(group.name);
  const [draftColor, setDraftColor] = useState(group.color ?? '#4ECDC4');

  const memberIds = new Set(members.map((m) => m.id));
  const candidates = allTrackers.filter((t) => !memberIds.has(t.id));

  async function addTracker() {
    if (!toAdd) return;
    setBusy(true);
    try {
      await core.groups.addTracker(group.id, toAdd);
      setToAdd('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function removeTracker(trackerId: string) {
    setBusy(true);
    try {
      await core.groups.removeTracker(group.id, trackerId);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup() {
    if (!confirm(`Delete group "${group.name}"? Trackers won’t be deleted.`)) return;
    setBusy(true);
    try {
      await core.groups.delete(group.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function reorderMembers(orderedTrackerIds: string[]) {
    setBusy(true);
    try {
      await core.groups.reorderMembers(group.id, orderedTrackerIds);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  function openSettings() {
    setDraftName(group.name);
    setDraftColor(group.color ?? '#4ECDC4');
    setEditing(true);
  }

  async function saveSettings() {
    const name = draftName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await core.groups.update(group.id, { name, color: draftColor });
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const dirty = draftName.trim() !== group.name || draftColor !== (group.color ?? '#4ECDC4');

  return (
    <div className="card group-card" style={{ borderLeftColor: group.color ?? 'var(--border)' }}>
      <div className="group-card__head">
        <DragHandle handleProps={dragHandleProps} label={`Reorder group ${group.name}`} />
        {editing ? (
          <>
            <input
              type="text"
              className="group-card__name-input"
              value={draftName}
              maxLength={120}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label="Group name"
            />
            <input
              type="color"
              value={draftColor}
              onChange={(e) => setDraftColor(e.target.value)}
              aria-label="Group color"
            />
          </>
        ) : (
          <h2 className="group-card__name">{group.name}</h2>
        )}
        <div className="group-card__actions">
          {editing ? (
            <>
              {dirty && (
                <button
                  className="btn btn--small btn--primary"
                  onClick={saveSettings}
                  disabled={busy || !draftName.trim()}
                >
                  Save
                </button>
              )}
              <button
                className="btn btn--small"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                Done
              </button>
            </>
          ) : (
            <button
              className="btn btn--small"
              onClick={openSettings}
              disabled={busy}
              aria-label={`Settings for ${group.name}`}
            >
              ⚙ Settings
            </button>
          )}
          <button className="btn btn--small btn--danger" onClick={deleteGroup} disabled={busy}>
            Delete
          </button>
        </div>
      </div>

      {editing && members.length > 1 && (
        <p className="muted group-card__reorder-hint">Drag ⠿ to reorder trackers.</p>
      )}

      {members.length === 0 ? (
        <p className="muted">No trackers in this group.</p>
      ) : editing ? (
        <SortableList
          items={members}
          className="group-card__members"
          itemClassName="group-member"
          onReorder={reorderMembers}
          renderItem={(m, handleProps) => (
            <>
              <DragHandle handleProps={handleProps} label={`Reorder ${m.name}`} />
              <span className="group-member__dot" style={{ background: m.color }} />
              <span className="group-member__name">{m.name}</span>
            </>
          )}
        />
      ) : (
        <ul className="group-card__members">
          {members.map((m) => (
            <li key={m.id} className="group-member">
              <span className="group-member__dot" style={{ background: m.color }} />
              <span className="group-member__name">{m.name}</span>
              <button
                className="btn btn--small"
                onClick={() => removeTracker(m.id)}
                disabled={busy}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {!editing && candidates.length > 0 && (
        <div className="group-card__add">
          <select
            value={toAdd}
            onChange={(e) => setToAdd(e.target.value)}
            aria-label={`Add tracker to ${group.name}`}
          >
            <option value="">Add a tracker…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn btn--small" onClick={addTracker} disabled={busy || !toAdd}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}
