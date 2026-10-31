import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Requires `Authorization: Bearer <token>` on every request. Both sides are hashed first, so the
 * comparison runs over equal-length buffers and does not leak the token length or prefix.
 */
export function registerAuth(app: FastifyInstance, apiToken: string): void {
  const expected = digest(apiToken);
  app.addHook('onRequest', async (req, reply) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    if (m === null || !timingSafeEqual(digest(m[1]!), expected)) {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ errors: [{ code: 'unauthorized', message: 'Нужен заголовок Authorization: Bearer <токен>' }] });
    }
    return undefined;
  });
}
