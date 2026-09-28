import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import request from 'supertest';
import routes from './queueInterventions';
setupTestDb();
async function app(permissions: Permission) {
  const user = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  await getRepository(User).update(user.id, { permissions });
  const server = express();
  server.use(express.json());
  // This in-memory app exercises authorization only; production checkUser applies rate limits.
  // codeql[js/missing-rate-limiting]
  server.use((req, _res, next) => {
    req.user = user;
    next();
  });
  server.use('/downloads/interventions', routes);
  server.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(error.status ?? 500).json({ message: error.message })
  );
  return server;
}
it('requires the current dedicated download permission even for existing request managers', async () => {
  const server = await app(Permission.MANAGE_REQUESTS);
  for (const endpoint of [
    '/downloads/interventions',
    '/downloads/interventions/1/preview',
    '/downloads/interventions/1/targets?query=example',
  ])
    assert.equal((await request(server).get(endpoint)).status, 403);
  assert.equal(
    (
      await request(server)
        .post('/downloads/interventions/1/reject')
        .send({ blocklist: true, removeFromClient: false })
    ).status,
    403
  );
});
it('allows explicitly granted download managers and rejects invalid action inputs before backend reads', async () => {
  const server = await app(Permission.MANAGE_DOWNLOADS);
  assert.equal(
    (
      await request(server)
        .post('/downloads/interventions/1/reject')
        .send({ blocklist: true, removeFromClient: 'yes' })
    ).status,
    400
  );
  assert.equal(
    (
      await request(server)
        .post('/downloads/interventions/1/import')
        .send({ candidateIds: [1], importMode: 'copy' })
    ).status,
    400
  );
  assert.equal(
    (await request(server).get('/downloads/interventions/bad/preview')).status,
    400
  );
});
