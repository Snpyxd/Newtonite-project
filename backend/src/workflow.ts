import { Action } from './permissions';

export const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'] as const;
export type Status = (typeof STATUSES)[number];
export const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/**
 * Allowed transitions and the permission each one needs.
 * Approval (awaiting_approval -> resolved, or sending it back) is Lead-only.
 *
 *  open -> in_progress -> awaiting_approval -> resolved -> closed
 *            ^   |             |  (lead)          |
 *            |   v             v                  v
 *           open        in_progress         in_progress (reopen)
 */
export const TRANSITIONS: Record<Status, Partial<Record<Status, Action>>> = {
  open: { in_progress: 'item:transition' },
  in_progress: { open: 'item:transition', awaiting_approval: 'item:transition' },
  awaiting_approval: { resolved: 'item:approve', in_progress: 'item:approve' },
  resolved: { closed: 'item:transition', in_progress: 'item:transition' },
  closed: {},
};
