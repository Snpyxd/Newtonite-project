import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, Item, label, Me, PRIORITIES, STATUSES, TYPES } from './api';
import { ItemRow } from './ui';

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export default function Items({ me, params }: { me: Me; params: URLSearchParams }) {
  const [f, setF] = useState({
    q: params.get('q') ?? '', status: params.get('status') ?? '', priority: params.get('priority') ?? '',
    assignee: params.get('assignee') ?? '', type: params.get('type') ?? '', team_id: params.get('team_id') ?? '',
  });
  useEffect(() => { // links from the dashboard change the query string
    setF({ q: params.get('q') ?? '', status: params.get('status') ?? '', priority: params.get('priority') ?? '',
      assignee: params.get('assignee') ?? '', type: params.get('type') ?? '', team_id: params.get('team_id') ?? '' });
  }, [params.toString()]);
  const q = useDebounced(f.q);

  const list = useInfiniteQuery({
    queryKey: ['items', { ...f, q }],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...f, q })) if (v) sp.set(k, v);
      if (pageParam) sp.set('cursor', String(pageParam));
      sp.set('limit', '25');
      return api<{ items: Item[]; next_cursor: number | null }>(`/items?${sp}`);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined, // server-side cursor pagination
  });

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const any = Object.values(f).some(Boolean);

  return (
    <div className="stack">
      <div className="head">
        <h1>All work items</h1>
        <a className="button" href="#/new">New item</a>
      </div>
      <div className="card filters">
        <input placeholder="Search title and description" value={f.q} onChange={set('q')} aria-label="Search" />
        <select value={f.team_id} onChange={set('team_id')} aria-label="Team">
          <option value="">All my teams</option>
          {me.memberships.map((m) => <option key={m.team_id} value={m.team_id}>{m.team_name}</option>)}
        </select>
        <select value={f.status} onChange={set('status')} aria-label="Status">
          <option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={f.priority} onChange={set('priority')} aria-label="Priority">
          <option value="">Any priority</option>{PRIORITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={f.type} onChange={set('type')} aria-label="Type">
          <option value="">Any type</option>{TYPES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={f.assignee} onChange={set('assignee')} aria-label="Assignee">
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
        </select>
        {any && <button className="ghost" onClick={() => { setF({ q: '', status: '', priority: '', assignee: '', type: '', team_id: '' }); location.hash = '#/items'; }}>Clear filters</button>}
      </div>
      <div className="card">
        {list.isLoading && <p className="muted">Loading…</p>}
        {list.error && <div className="banner error">{(list.error as Error).message}</div>}
        {!list.isLoading && rows.length === 0 && <p className="empty">No items match these filters.</p>}
        {rows.map((i) => <ItemRow key={i.id} item={i} />)}
        {list.hasNextPage && (
          <button className="ghost center" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            {list.isFetchingNextPage ? 'Loading…' : 'Load 25 more'}
          </button>
        )}
        {rows.length > 0 && !list.hasNextPage && <p className="muted center">End of list · {rows.length} shown</p>}
      </div>
    </div>
  );
}
