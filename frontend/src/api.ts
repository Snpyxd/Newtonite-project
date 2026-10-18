export type Role = 'viewer' | 'member' | 'lead' | 'admin';
export type Status = 'open' | 'in_progress' | 'awaiting_approval' | 'resolved' | 'closed';
export interface Me {
  id: number; name: string; email: string;
  memberships: { team_id: number; team_name: string; role: Role }[];
}
export interface Item {
  id: number; title: string; description: string; type: string; priority: string; status: Status;
  team_id: number; team_name: string; assignee_id: number | null; assignee_name: string | null;
  created_by_name: string; due_date: string | null; version: number; created_at: string; updated_at: string;
  permissions?: { can_edit: boolean; can_claim: boolean; can_assign: boolean; can_comment: boolean; transitions: Status[] };
}
export interface ActivityEvent {
  id: number; kind: string; old_value: string | null; new_value: string | null; created_at: string; actor_name: string | null;
}

export const STATUSES: Status[] = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
export const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const getToken = () => localStorage.getItem('ops_token');
export const setToken = (t: string | null) => (t ? localStorage.setItem('ops_token', t) : localStorage.removeItem('ops_token'));

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) {
    super(message);
  }
  get isConflict() { return this.status === 409; }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.key ? { 'Idempotency-Key': opts.key } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && token && path !== '/auth/login') {
      setToken(null);
      location.reload();
    }
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data);
  }
  return data as T;
}

export const newKey = () => crypto.randomUUID();
