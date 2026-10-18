import { forbidden } from './errors';

export type Role = 'viewer' | 'member' | 'lead' | 'admin';
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, lead: 2, admin: 3 };

export type Action =
  | 'item:read'
  | 'item:create'
  | 'item:update'
  | 'item:claim'
  | 'item:comment'
  | 'item:transition'
  | 'item:assign' // assign/reassign to someone else
  | 'item:approve'; // pass or reject the approval step

// The role x action matrix lives in exactly one place: the minimum role per action.
// admin >= lead >= member >= viewer. (Admin-only team management is out of scope.)
const MIN_ROLE: Record<Action, Role> = {
  'item:read': 'viewer',
  'item:create': 'member',
  'item:update': 'member',
  'item:claim': 'member',
  'item:comment': 'member',
  'item:transition': 'member',
  'item:assign': 'lead',
  'item:approve': 'lead',
};

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  memberships: Map<number, Role>; // teamId -> role
}

/** THE permission check. Every endpoint goes through this, scoped to the item's team. */
export function can(user: AuthUser, action: Action, teamId: number): boolean {
  const role = user.memberships.get(teamId);
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[action]];
}

export function assertCan(user: AuthUser, action: Action, teamId: number) {
  if (!can(user, action, teamId)) throw forbidden();
}

export function teamsWith(user: AuthUser, action: Action): number[] {
  return [...user.memberships.keys()].filter((t) => can(user, action, t));
}
