import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ReaderDeliverySettings } from '@server/lib/settings';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

import { readerDeliveryConnectionTestBody } from './readerDeliveryConnectionTest';

const createValidatedApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.post('/api/v1/settings/reader-delivery/connection-test', (_req, res) =>
    res.status(200).json({})
  );
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) =>
      res.status(error.status ?? 500).json({
        status: error.status ?? 500,
        message: error.message,
      })
  );
  return app;
};

const draft = (fields: Partial<ReaderDeliverySettings>) =>
  ({
    grimmoryUrl: 'https://grimmory.example.test/reader',
    grimmoryUsername: 'shelf-admin',
    grimmoryPassword: 'invented-grimmory-password',
    bookorbitUrl: 'https://bookorbit.example.test',
    bookorbitUsername: 'scope-owner',
    bookorbitPassword: 'invented-bookorbit-password',
    preferredProvider: 'grimmory',
    ...fields,
  }) as ReaderDeliverySettings;

const drafts: [string, Partial<ReaderDeliverySettings>][] = [
  ['a typed password', {}],
  [
    'the redacted saved password',
    { grimmoryPassword: '[REDACTED]', bookorbitPassword: '[REDACTED]' },
  ],
  ['a blank password', { grimmoryPassword: '', bookorbitPassword: '' }],
  [
    'a blank address and account',
    {
      grimmoryUrl: '',
      grimmoryUsername: '',
      grimmoryPassword: '',
      bookorbitUrl: '',
      bookorbitUsername: '',
      bookorbitPassword: '',
    },
  ],
];

describe('reader app connection-test bodies behind the OpenAPI validator', () => {
  const app = createValidatedApp();

  for (const provider of ['grimmory', 'bookorbit'] as const) {
    it(`sends only the ${provider} form values`, () => {
      const body = readerDeliveryConnectionTestBody(provider, draft({}));

      assert.deepEqual(
        body,
        provider === 'grimmory'
          ? {
              provider,
              url: 'https://grimmory.example.test/reader',
              username: 'shelf-admin',
              password: 'invented-grimmory-password',
            }
          : {
              provider,
              url: 'https://bookorbit.example.test',
              username: 'scope-owner',
              password: 'invented-bookorbit-password',
            }
      );
    });

    for (const [name, fields] of drafts) {
      it(`accepts a ${provider} test with ${name}`, async () => {
        const response = await request(app)
          .post('/api/v1/settings/reader-delivery/connection-test')
          .send(readerDeliveryConnectionTestBody(provider, draft(fields)));

        assert.equal(response.status, 200, JSON.stringify(response.body));
      });
    }
  }

  it('accepts a test of the saved settings by provider alone', async () => {
    const response = await request(app)
      .post('/api/v1/settings/reader-delivery/connection-test')
      .send({ provider: 'bookorbit' });

    assert.equal(response.status, 200, JSON.stringify(response.body));
  });

  it('refuses fields the connection test does not take', async () => {
    const response = await request(app)
      .post('/api/v1/settings/reader-delivery/connection-test')
      .send({
        ...readerDeliveryConnectionTestBody('bookorbit', draft({})),
        preferredProvider: 'bookorbit',
      });

    assert.equal(response.status, 400);
  });

  it('refuses values past the settings limits', async () => {
    for (const fields of [
      { bookorbitUrl: 'https://bookorbit.example.test/' + 'a'.repeat(2048) },
      { bookorbitUsername: 'a'.repeat(257) },
      { bookorbitPassword: 'a'.repeat(2049) },
    ]) {
      const response = await request(app)
        .post('/api/v1/settings/reader-delivery/connection-test')
        .send(readerDeliveryConnectionTestBody('bookorbit', draft(fields)));

      assert.equal(response.status, 400, JSON.stringify(fields));
    }
  });
});
