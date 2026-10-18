import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, Item, label, Me, newKey, PRIORITIES, TYPES } from './api';
import { ErrorBanner, Field, nav } from './ui';

export default function NewItem({ me }: { me: Me }) {
  const qc = useQueryClient();
  const teams = me.memberships.filter((m) => m.role !== 'viewer');
  const [f, setF] = useState({ title: '', description: '', type: 'task', priority: 'medium',
    team_id: String(teams[0]?.team_id ?? ''), due_date: '', assignee_id: '' });
  // One idempotency key per *attempt*. Double-clicks and retries reuse it, so only one item is created.
  const key = useRef(newKey());
  const team = teams.find((t) => String(t.team_id) === f.team_id);
  const canAssign = team?.role === 'lead' || team?.role === 'admin';
  const members = useQuery({
    queryKey: ['members', f.team_id], enabled: !!f.team_id && canAssign,
    queryFn: () => api<{ id: number; name: string; role: string }[]>(`/teams/${f.team_id}/members`),
  });

  const create = useMutation({
    mutationFn: () => api<Item>('/items', { method: 'POST', key: key.current, body: {
      title: f.title, description: f.description, type: f.type, priority: f.priority, team_id: Number(f.team_id),
      due_date: f.due_date || null, assignee_id: f.assignee_id ? Number(f.assignee_id) : null,
    } }),
    onSuccess: (item) => {
      key.current = newKey(); // next form gets a fresh key
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      nav(`#/items/${item.id}`);
    },
  });

  if (!teams.length) return <div className="banner error">Your role is read only, so you cannot create items.</div>;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); if (!create.isPending) create.mutate(); }}>
      <h1>New work item</h1>
      <ErrorBanner error={create.error as ApiError | null} onDismiss={() => create.reset()} />
      <Field label="Title"><input required maxLength={200} value={f.title} onChange={set('title')} autoFocus /></Field>
      <Field label="Description"><textarea rows={4} value={f.description} onChange={set('description')} /></Field>
      <div className="grid2">
        <Field label="Team"><select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value, assignee_id: '' })}>
          {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}</select></Field>
        <Field label="Type"><select value={f.type} onChange={set('type')}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Priority"><select value={f.priority} onChange={set('priority')}>{PRIORITIES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Due date"><input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        {canAssign && (
          <Field label="Assign to"><select value={f.assignee_id} onChange={set('assignee_id')}>
            <option value="">Leave unassigned</option>
            {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        )}
      </div>
      <div className="actions">
        <button type="submit" disabled={create.isPending || !f.title.trim()}>{create.isPending ? 'Creating…' : 'Create item'}</button>
        <a className="button ghost" href="#/items">Cancel</a>
      </div>
    </form>
  );
}
