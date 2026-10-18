import express, { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './errors';
import { session } from './routes/session';
import { items } from './routes/items';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(session);
  app.use(items);

  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'Route not found.' }));

  // Single error translator: every failure becomes { error, message, ...extra }.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'validation_error',
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON.' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong on our side.' });
  });
  return app;
}
