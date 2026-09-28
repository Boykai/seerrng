import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/integrations/discovery', (_req, res) =>
    res.json({ validated: true })
  );
  app.use(
    (
      error: { status?: number },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(error.status ?? 500).json({ failed: true })
  );
  return app;
}
describe('discovery integration OpenAPI contracts', () => {
  it('allows each implemented endpoint through validation', async () => {
    const app = createApp();
    assert.equal(
      (await request(app).get('/api/v1/integrations/discovery/configuration'))
        .status,
      200
    );
    assert.equal(
      (await request(app).get('/api/v1/integrations/discovery/accounts'))
        .status,
      200
    );
    assert.equal(
      (
        await request(app)
          .put('/api/v1/integrations/discovery/configuration')
          .send({ trakt: { clientId: 'id', clientSecret: 'secret' } })
      ).status,
      200
    );
    assert.equal(
      (
        await request(app).post(
          '/api/v1/integrations/discovery/accounts/trakt/connect'
        )
      ).status,
      200
    );
    assert.equal(
      (
        await request(app)
          .post('/api/v1/integrations/discovery/accounts/trakt/complete')
          .send({})
      ).status,
      200
    );
    assert.equal(
      (
        await request(app)
          .post('/api/v1/integrations/discovery/accounts/anilist/complete')
          .send({ code: 'pin' })
      ).status,
      200
    );
    assert.equal(
      (
        await request(app)
          .put('/api/v1/integrations/discovery/accounts/simkl/preferences')
          .send({ allowWrites: true })
      ).status,
      200
    );
    assert.equal(
      (
        await request(app).delete(
          '/api/v1/integrations/discovery/accounts/simkl'
        )
      ).status,
      200
    );
  });
  it('rejects arbitrary credentials and unknown providers', async () => {
    const app = createApp();
    assert.equal(
      (
        await request(app)
          .put('/api/v1/integrations/discovery/configuration')
          .send({ trakt: { accessToken: 'secret' } })
      ).status,
      400
    );
    assert.equal(
      (
        await request(app).post(
          '/api/v1/integrations/discovery/accounts/other/connect'
        )
      ).status,
      400
    );
    assert.equal(
      (
        await request(app)
          .post('/api/v1/integrations/discovery/accounts/trakt/complete')
          .send({ deviceCode: 'injected' })
      ).status,
      400
    );
  });
});
