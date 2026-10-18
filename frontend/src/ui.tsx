import { ReactNode } from 'react';
import { ApiError, Item, label } from './api';

export const nav = (hash: string) => { location.hash = hash; };

export function Badge({ kind, value }: { kind: 'status' | 'priority'; value: string }) {
  return <span className={`badge ${kind}-${value}`}>{label(value)}</span>;
}

export function ItemRow({ item }: { item: Item }) {
  return (
    <a className="row" href={`#/items/${item.id}`}>
      <span className="row-title">{item.title}</span>
      <span className="row-meta">
        {item.team_name} · {item.assignee_name ?? 'Unassigned'}
        {item.due_date ? ` · due ${item.due_date}` : ''}
      </span>
      <span className="row-badges">
        <Badge kind="priority" value={item.priority} />
        <Badge kind="status" value={item.status} />
      </span>
    </a>
  );
}

/** Explains what went wrong in plain words. A 409 gets a Reload button. */
export function ErrorBanner({ error, onReload, onDismiss }: { error: unknown; onReload?: () => void; onDismiss?: () => void }) {
  if (!error) return null;
  const e = error as ApiError;
  const conflict = e.status === 409;
  return (
    <div className="banner error" role="alert">
      <span>
        {conflict && e.code === 'version_conflict' ? 'This item changed while you were looking at it. ' : ''}
        {e.message}
      </span>
      <span className="banner-actions">
        {conflict && onReload && <button onClick={onReload}>Reload latest</button>}
        {onDismiss && <button className="ghost" onClick={onDismiss}>Dismiss</button>}
      </span>
    </div>
  );
}

export function Field({ label: l, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{l}</span>{children}</label>;
}

export const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
