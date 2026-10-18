export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new HttpError(404, 'not_found', m);
export const unauthorized = (m = 'Authentication required.') => new HttpError(401, 'unauthorized', m);
