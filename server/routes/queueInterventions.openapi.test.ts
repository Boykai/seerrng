import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { it } from 'node:test';
import request from 'supertest';
function app() {
  const result = express();
  result.use(express.json());
  result.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  result.get('/api/v1/downloads/interventions', (req, res) =>
    res.json({ page: req.query.page })
  );
  result.get('/api/v1/downloads/interventions/:id/preview', (_req, res) =>
    res.json({ target: null, candidates: [], fingerprint: 'a'.repeat(64) })
  );
  result.get('/api/v1/downloads/interventions/:id/targets', (_req, res) =>
    res.json([])
  );
  result.post('/api/v1/downloads/interventions/:id/:action', (req, res) =>
    res.json(req.body)
  );
  result.use(
    (
      error: { status?: number },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(error.status ?? 500).json({ failed: true })
  );
  return result;
}
it('accepts bounded inbox queries and explicit action contracts', async () => {
  const server = app();
  assert.equal(
    (
      await request(server).get(
        '/api/v1/downloads/interventions?scope=history&page=2'
      )
    ).status,
    200
  );
  assert.equal(
    (await request(server).get('/api/v1/downloads/interventions/1/preview'))
      .status,
    200
  );
  assert.equal(
    (
      await request(server).get(
        '/api/v1/downloads/interventions/1/targets?query=Example'
      )
    ).status,
    200
  );
  assert.equal(
    (
      await request(server)
        .post('/api/v1/downloads/interventions/1/reject')
        .send({ blocklist: true, removeFromClient: false })
    ).status,
    200
  );
  assert.equal(
    (
      await request(server)
        .post('/api/v1/downloads/interventions/1/import')
        .send({
          candidateIds: [7],
          importMode: 'copy',
          fingerprint: 'a'.repeat(64),
          targetId: 9,
        })
    ).status,
    200
  );
});
it('rejects duplicate selections, browser-supplied paths, missing fingerprints, and malformed scope', async () => {
  const server = app();
  for (const body of [
    { candidateIds: [7, 7], importMode: 'copy', fingerprint: 'a'.repeat(64) },
    { candidateIds: [7], importMode: 'copy' },
    {
      candidateIds: [7],
      importMode: 'copy',
      fingerprint: 'a'.repeat(64),
      path: '/arbitrary/path',
    },
    { candidateIds: [], importMode: 'move', fingerprint: 'a'.repeat(64) },
    {
      candidateIds: [7],
      importMode: 'move',
      fingerprint: 'a'.repeat(64),
      targetId: 0,
    },
  ])
    assert.equal(
      (
        await request(server)
          .post('/api/v1/downloads/interventions/1/import')
          .send(body)
      ).status,
      400
    );
  assert.equal(
    (
      await request(server).get(
        '/api/v1/downloads/interventions?scope=everything'
      )
    ).status,
    400
  );
  assert.equal(
    (
      await request(server).get(
        '/api/v1/downloads/interventions/1/targets?query=x'
      )
    ).status,
    400
  );
  assert.equal(
    (
      await request(server)
        .post('/api/v1/downloads/interventions/1/reject')
        .send({ blocklist: 'yes', removeFromClient: false })
    ).status,
    400
  );
});
