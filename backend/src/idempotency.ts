import crypto from 'crypto';
import { Request, RequestHandler } from 'express';
import { tx, Tx } from './db';
import { HttpError } from './errors';

export interface Result { status: number; body: unknown }

/**
 * Wraps a mutating handler in ONE transaction and, when the client sends an
 * Idempotency-Key header, makes it safe to retry.
 *
 * 1. INSERT the key ... ON CONFLICT DO NOTHING. If another request with the same key is
 *    still in flight, Postgres makes this INSERT wait for it to commit or roll back.
 * 2. Inserted -> run the handler, store its response in the same transaction.
 * 3. Not inserted -> the first request committed: return its stored response (a replay).
 * A failed attempt rolls back the key too, so a retry after an error runs again.
 */
export function mutation(handler: (req: Request, c: Tx) => Promise<Result>): RequestHandler {
  return async (req, res) => {
    const key = req.header('idempotency-key');
    if (key !== undefined && (key.length < 8 || key.length > 200)) {
      throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-200 characters.');
    }
    const out = await tx(async (c) => {
      if (!key) return { ...(await handler(req, c)), replay: false };
      const userId = req.user!.id;
      const hash = crypto
        .createHash('sha256')
        .update(req.method + req.originalUrl + JSON.stringify(req.body ?? {}))
        .digest('hex');
      const ins = await c.query(
        `INSERT INTO idempotency_keys(key, user_id, request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key`,
        [key, userId, hash],
      );
      if (ins.rowCount === 0) {
        const r = await c.query(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key=$1 AND user_id=$2`,
          [key, userId],
        );
        const row = r.rows[0];
        if (row.request_hash !== hash) {
          throw new HttpError(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used for a different request.');
        }
        return { status: row.response_status as number, body: row.response_body, replay: true };
      }
      const result = await handler(req, c);
      await c.query(
        `UPDATE idempotency_keys SET response_status=$3, response_body=$4 WHERE key=$1 AND user_id=$2`,
        [key, userId, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replay: false };
    });
    if (out.replay) res.set('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  };
}
