import bcrypt from 'bcryptjs';
import { pool } from './db';
import { migrate } from './migrate';

const PASSWORD = 'password123';
const TEAMS = ['Payments Ops', 'Customer Support', 'Compliance', 'Platform Incidents'];
type Role = 'viewer' | 'member' | 'lead' | 'admin';
// [email-prefix, name, [[team index, role], ...]]
const USERS: [string, string, [number, Role][]][] = [
  ['alice.admin', 'Alice Admin', [[0, 'admin'], [1, 'admin'], [2, 'admin'], [3, 'admin']]],
  ['liam.lead', 'Liam Lead', [[0, 'lead'], [1, 'member']]],
  ['lena.lead', 'Lena Lead', [[1, 'lead'], [2, 'lead']]],
  ['luke.lead', 'Luke Lead', [[3, 'lead']]],
  ['mia.member', 'Mia Member', [[0, 'member'], [1, 'member']]],
  ['mark.member', 'Mark Member', [[0, 'member']]],
  ['sara.member', 'Sara Member', [[1, 'member'], [3, 'member']]],
  ['noah.member', 'Noah Member', [[2, 'member'], [3, 'member']]],
  ['vera.viewer', 'Vera Viewer', [[0, 'viewer'], [1, 'viewer']]],
  ['victor.viewer', 'Victor Viewer', [[2, 'viewer']]],
];
const SUBJECTS = ['Payment failed for merchant', 'Refund stuck in pending', 'Chargeback dispute', 'Login errors spike', 'KYC document expired',
  'Audit evidence missing', 'Customer cannot reset password', 'API latency above SLO', 'Duplicate invoice generated', 'Settlement file mismatch',
  'Suspicious transaction review', 'Database failover test', 'Webhook delivery delays', 'Card declined at checkout', 'Policy update acknowledgement'];
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function main() {
  await migrate();
  const ifEmpty = process.argv.includes('--if-empty');
  if (ifEmpty && (await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
    console.log('seed skipped: database already has data');
    return pool.end();
  }
  const count = Number(process.env.SEED_ITEMS ?? 5000);
  await pool.query('TRUNCATE outbox, notifications, idempotency_keys, activity_events, work_items, memberships, users, teams RESTART IDENTITY CASCADE');

  const hash = await bcrypt.hash(PASSWORD, 10);
  const teamIds: number[] = [];
  for (const t of TEAMS) teamIds.push((await pool.query('INSERT INTO teams(name) VALUES($1) RETURNING id', [t])).rows[0].id);
  const workers: number[][] = TEAMS.map(() => []); // non-viewers per team
  for (const [prefix, name, ms] of USERS) {
    const id = (await pool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id', [`${prefix}@demo.test`, name, hash])).rows[0].id;
    for (const [ti, role] of ms) {
      await pool.query('INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)', [id, teamIds[ti], role]);
      if (role !== 'viewer') workers[ti].push(id);
    }
  }

  const now = Date.now();
  const rows = Array.from({ length: count }, (_, i) => {
    const ti = i % TEAMS.length;
    const status = pick(['open', 'open', 'in_progress', 'in_progress', 'awaiting_approval', 'resolved', 'closed']);
    const unassigned = status === 'open' && Math.random() < 0.5; // only open items may be unassigned
    return {
      title: `${pick(SUBJECTS)} #${1000 + i}`,
      description: `Seeded ${pick(['investigate', 'escalate', 'follow up on', 'resolve'])} item for ${TEAMS[ti]}.`,
      type: pick(TYPES),
      priority: pick(['low', 'low', 'medium', 'medium', 'high', 'urgent']),
      status,
      team_id: teamIds[ti],
      assignee_id: unassigned ? null : pick(workers[ti]),
      created_by: pick(workers[ti]),
      due_date: Math.random() < 0.7 ? new Date(now + (Math.random() * 30 - 5) * 864e5).toISOString().slice(0, 10) : null,
      created_at: new Date(now - (count - i) * 60_000).toISOString(),
    };
  });
  for (let i = 0; i < rows.length; i += 1000) {
    await pool.query(
      `INSERT INTO work_items(title, description, type, priority, status, team_id, assignee_id, created_by, due_date, created_at, updated_at)
       SELECT title, description, type, priority, status, team_id, assignee_id, created_by, due_date, created_at, created_at
       FROM json_populate_recordset(null::work_items, $1::json) ORDER BY created_at`,
      [JSON.stringify(rows.slice(i, i + 1000))],
    );
  }
  await pool.query(
    `INSERT INTO activity_events(item_id, actor_id, kind, new_value, created_at)
     SELECT id, created_by, 'created', title, created_at FROM work_items`,
  );
  console.log(`seeded ${TEAMS.length} teams, ${USERS.length} users, ${count} items. Password for everyone: ${PASSWORD}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
