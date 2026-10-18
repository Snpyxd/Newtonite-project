import { useQuery } from '@tanstack/react-query';
import { api, Item } from './api';
import { ItemRow } from './ui';

type View = { total: number; items: Item[] };
interface Dash { assigned_to_me: View; unassigned_urgent: View; awaiting_my_approval: View }

const SECTIONS: [keyof Dash, string, string, string][] = [
  ['assigned_to_me', 'Assigned to me', 'Open work that is yours.', '#/items?assignee=me'],
  ['unassigned_urgent', 'Unassigned urgent', 'Urgent items nobody owns yet. Claim one.', '#/items?assignee=unassigned&priority=urgent'],
  ['awaiting_my_approval', 'Awaiting my approval', 'Waiting on a Lead from your teams.', '#/items?status=awaiting_approval'],
];

export default function Dashboard() {
  // Refetching every 10s is the "real-time" story: simple, and good enough for this scope.
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dash>('/dashboard'), refetchInterval: 10_000 });
  const notes = useQuery({
    queryKey: ['notifications'], refetchInterval: 10_000,
    queryFn: () => api<{ id: number; item_id: number; message: string; created_at: string }[]>('/notifications'),
  });

  if (dash.isLoading) return <p className="muted">Loading your dashboard…</p>;
  if (dash.error) return <div className="banner error">{(dash.error as Error).message}</div>;

  return (
    <div className="stack">
      <h1>Needs attention</h1>
      <div className="grid3">
        {SECTIONS.map(([key, title, hint, href]) => {
          const v = dash.data![key];
          return (
            <section key={key} className="card">
              <header className="section-head">
                <div><h2>{title}</h2><p className="muted">{hint}</p></div>
                <a href={href} className="count" title="See all">{v.total}</a>
              </header>
              {v.items.length === 0 ? <p className="empty">Nothing here right now.</p> : v.items.map((i) => <ItemRow key={i.id} item={i} />)}
              {v.total > v.items.length && <a className="more" href={href}>See all {v.total}</a>}
            </section>
          );
        })}
      </div>
      <section className="card">
        <h2>Notifications</h2>
        <p className="muted">Delivered by the background worker from the outbox.</p>
        {notes.data?.length ? notes.data.map((n) => (
          <a key={n.id} className="row" href={`#/items/${n.item_id}`}><span className="row-title">{n.message}</span></a>
        )) : <p className="empty">No notifications yet. Claim an item and watch one arrive.</p>}
      </section>
    </div>
  );
}
