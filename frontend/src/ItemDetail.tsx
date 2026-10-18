import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityEvent, api, ApiError, Item, label, Me, newKey, PRIORITIES, Status, TYPES } from './api';
import { Badge, ErrorBanner, Field, fmt } from './ui';

function describe(e: ActivityEvent) {
  switch (e.kind) {
    case 'created': return 'created this item';
    case 'status_changed': return `moved it from ${label(e.old_value ?? '')} to ${label(e.new_value ?? '')}`;
    case 'priority_changed': return `changed priority from ${label(e.old_value ?? '')} to ${label(e.new_value ?? '')}`;
    case 'assigned': return e.old_value ? `reassigned it from ${e.old_value} to ${e.new_value}` : `assigned it to ${e.new_value}`;
    case 'unassigned': return `unassigned ${e.old_value ?? 'it'}`;
    case 'updated': return `edited ${e.new_value}`;
    case 'commented': return 'commented';
    default: return e.kind;
  }
}

export default function ItemDetail({ id, me }: { id: number; me: Me }) {
  const qc = useQueryClient();
  const itemKey = ['item', id];
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<{ version: number } | null>(null);
  const [comment, setComment] = useState('');

  const item = useQuery({ queryKey: itemKey, queryFn: () => api<Item>(`/items/${id}`) });
  const activity = useInfiniteQuery({
    queryKey: ['activity', id], initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<{ events: ActivityEvent[]; next_cursor: number | null }>(`/items/${id}/activity?limit=15${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.next_cursor ?? undefined,
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: itemKey });
    qc.invalidateQueries({ queryKey: ['activity', id] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['items'] });
  };
  const reload = () => { setError(null); setEditing(null); refreshAll(); };

  /** Optimistic update: show the result now, roll back and explain if the server says no. */
  const optimistic = (patch: (i: Item) => Item) => ({
    onMutate: async () => {
      setError(null);
      await qc.cancelQueries({ queryKey: itemKey });
      const prev = qc.getQueryData<Item>(itemKey);
      if (prev) qc.setQueryData(itemKey, patch(prev));
      return { prev };
    },
    onError: (err: unknown, _v: unknown, ctx?: { prev?: Item }) => {
      if (ctx?.prev) qc.setQueryData(itemKey, ctx.prev); // roll back
      setError(err);
    },
    onSettled: refreshAll, // reconcile with the server's truth either way
  });

  const claim = useMutation({
    mutationFn: (key: string) => api<Item>(`/items/${id}/claim`, { method: 'POST', key }),
    ...optimistic((i) => ({ ...i, assignee_id: me.id, assignee_name: me.name, permissions: { ...i.permissions!, can_claim: false } })),
  });
  const transition = useMutation({
    mutationFn: (v: { to: Status; key: string }) => api<Item>(`/items/${id}/transition`, { method: 'POST', key: v.key, body: { to: v.to, version: item.data!.version } }),
    ...optimistic((i) => ({ ...i, permissions: { ...i.permissions!, transitions: [] } })),
    onMutate: async (v: { to: Status; key: string }) => {
      setError(null);
      await qc.cancelQueries({ queryKey: itemKey });
      const prev = qc.getQueryData<Item>(itemKey);
      if (prev) qc.setQueryData(itemKey, { ...prev, status: v.to, permissions: { ...prev.permissions!, transitions: [] } });
      return { prev };
    },
  });
  const addComment = useMutation({
    mutationFn: (v: { body: string; key: string }) => api(`/items/${id}/comments`, { method: 'POST', key: v.key, body: { body: v.body } }),
    onSuccess: () => { setComment(''); qc.invalidateQueries({ queryKey: ['activity', id] }); },
    onError: setError,
  });

  if (item.isLoading) return <p className="muted">Loading…</p>;
  if (item.error) return <div className="banner error">{(item.error as Error).message} <a href="#/items">Back to items</a></div>;
  const it = item.data!;
  const p = it.permissions!;
  const busy = claim.isPending || transition.isPending;

  return (
    <div className="stack">
      <a href="#/items" className="back">Back to items</a>
      <ErrorBanner error={error as ApiError} onReload={reload} onDismiss={() => setError(null)} />

      <section className="card">
        <div className="head">
          <div>
            <h1>{it.title}</h1>
            <p className="muted">{it.team_name} · {label(it.type)} · created by {it.created_by_name} · version {it.version}</p>
          </div>
          <div className="row-badges"><Badge kind="priority" value={it.priority} /><Badge kind="status" value={it.status} /></div>
        </div>
        <p className="desc">{it.description || <span className="muted">No description.</span>}</p>
        <dl className="facts">
          <div><dt>Assignee</dt><dd>{it.assignee_name ?? 'Unassigned'}</dd></div>
          <div><dt>Due</dt><dd>{it.due_date ?? 'No due date'}</dd></div>
          <div><dt>Updated</dt><dd>{fmt(it.updated_at)}</dd></div>
        </dl>

        <div className="actions">
          {p.can_claim && <button disabled={busy} onClick={() => claim.mutate(newKey())}>Claim this item</button>}
          {p.transitions.map((to) => (
            <button key={to} className={to === 'resolved' ? '' : 'ghost'} disabled={busy} onClick={() => transition.mutate({ to, key: newKey() })}>
              {it.status === 'awaiting_approval' && to === 'resolved' ? 'Approve and resolve' :
               it.status === 'awaiting_approval' && to === 'in_progress' ? 'Send back' : `Move to ${label(to)}`}
            </button>
          ))}
          {p.can_edit && !editing && <button className="ghost" onClick={() => setEditing({ version: it.version })}>Edit</button>}
        </div>
        {!p.can_claim && !p.transitions.length && !p.can_edit && <p className="muted">Your role on this team is read only for this item.</p>}
      </section>

      {editing && p.can_edit && <EditForm item={it} version={editing.version} canAssign={p.can_assign}
        onDone={() => { setEditing(null); refreshAll(); }} onError={setError} />}

      <section className="card">
        <h2>Activity</h2>
        {p.can_comment && (
          <form className="comment" onSubmit={(e) => { e.preventDefault(); if (comment.trim() && !addComment.isPending) addComment.mutate({ body: comment, key: newKey() }); }}>
            <input placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
            <button disabled={!comment.trim() || addComment.isPending}>Comment</button>
          </form>
        )}
        <ol className="timeline">
          {activity.data?.pages.flatMap((pg) => pg.events).map((e) => (
            <li key={e.id} className={e.kind}>
              <div><strong>{e.actor_name ?? 'System'}</strong> {describe(e)} <time>{fmt(e.created_at)}</time></div>
              {e.kind === 'commented' && <blockquote>{e.new_value}</blockquote>}
            </li>
          ))}
        </ol>
        {activity.hasNextPage && <button className="ghost center" onClick={() => activity.fetchNextPage()}>Show older activity</button>}
      </section>
    </div>
  );
}

function EditForm({ item, version, canAssign, onDone, onError }: {
  item: Item; version: number; canAssign: boolean; onDone: () => void; onError: (e: unknown) => void;
}) {
  const [f, setF] = useState({ title: item.title, description: item.description, type: item.type, priority: item.priority,
    due_date: item.due_date ?? '', assignee_id: item.assignee_id ? String(item.assignee_id) : '' });
  const members = useQuery({ queryKey: ['members', item.team_id], enabled: canAssign,
    queryFn: () => api<{ id: number; name: string }[]>(`/teams/${item.team_id}/members`) });
  const key = useState(newKey)[0];
  const save = useMutation({
    // Sends the version this form was opened with. If someone else saved first, the server answers 409.
    mutationFn: () => api<Item>(`/items/${item.id}`, { method: 'PATCH', key, body: {
      version, title: f.title, description: f.description, type: f.type, priority: f.priority,
      due_date: f.due_date || null, ...(canAssign ? { assignee_id: f.assignee_id ? Number(f.assignee_id) : null } : {}),
    } }),
    onSuccess: onDone,
    onError,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); if (!save.isPending) save.mutate(); }}>
      <h2>Edit item</h2>
      <Field label="Title"><input required value={f.title} onChange={set('title')} maxLength={200} /></Field>
      <Field label="Description"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
      <div className="grid2">
        <Field label="Type"><select value={f.type} onChange={set('type')}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Priority"><select value={f.priority} onChange={set('priority')}>{PRIORITIES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Due date"><input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        {canAssign && <Field label="Assignee (Leads only)"><select value={f.assignee_id} onChange={set('assignee_id')}>
          <option value="">Unassigned</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>}
      </div>
      <div className="actions">
        <button disabled={save.isPending || !f.title.trim()}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
