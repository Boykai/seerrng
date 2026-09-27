import { User } from '@server/entity/User';
import * as sync from '@server/lib/collectionSync';
import { Permission } from '@server/lib/permissions';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import collectionRoutes from './collection';

const app = (permissions?: number) => {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    if (permissions !== undefined) req.user = new User({ id: 1, permissions });
    next();
  });
  instance.use('/collection', collectionRoutes);
  instance.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  instance.use('/api/v1/collection', collectionRoutes);
  instance.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
  return instance;
};
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(sync, 'checkCollection').mockResolvedValue({
    supported: true,
    checkedAt: 1,
    destinations: [],
  });
});
describe('collection action authorization', () => {
  it('admits all actions through the real OpenAPI schema', async () => {
    expect(
      (
        await request(app(Permission.ADMIN))
          .post('/api/v1/collection/55/server')
          .send({ libraryIds: ['server'] })
      ).status
    ).toBe(200);
    expect(
      (
        await request(app(Permission.ADMIN))
          .delete('/api/v1/collection/55/server')
          .send({
            destinations: [{ libraryId: '1', removalToken: 'a'.repeat(64) }],
          })
      ).status
    ).toBe(200);
    expect(
      (
        await request(app(Permission.ADMIN))
          .delete('/api/v1/collection/55/server')
          .send({ destinations: [{ libraryId: '1' }] })
      ).status
    ).toBe(400);
  });
  it('requires an administrator for both mutations', async () => {
    for (const permissions of [undefined, Permission.REQUEST]) {
      expect(
        (
          await request(app(permissions))
            .post('/collection/55/server')
            .send({ libraryIds: ['1'] })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app(permissions))
            .delete('/collection/55/server')
            .send({ destinations: [] })
        ).status
      ).toBe(403);
    }
    expect(sync.checkCollection).not.toHaveBeenCalled();
  });
  it('accepts generic server and library targets, with bounded validation', async () => {
    expect(
      (
        await request(app(Permission.ADMIN))
          .post('/collection/55/server')
          .send({ libraryIds: ['server'] })
      ).status
    ).toBe(200);
    expect(sync.checkCollection).toHaveBeenCalledWith(
      55,
      ['server'],
      undefined,
      { selectedIds: undefined }
    );
    expect(
      (
        await request(app(Permission.ADMIN))
          .post('/collection/55/server')
          .send({ libraryIds: ['../movie'] })
      ).status
    ).toBe(400);
  });
  it('requires verified removal tokens and rejects duplicate destinations', async () => {
    const destination = { libraryId: '1', removalToken: 'a'.repeat(64) };
    expect(
      (
        await request(app(Permission.ADMIN))
          .delete('/collection/55/server')
          .send({ destinations: [destination] })
      ).status
    ).toBe(200);
    expect(sync.checkCollection).toHaveBeenCalledWith(55, undefined, [
      destination,
    ]);
    expect(
      (
        await request(app(Permission.ADMIN))
          .delete('/collection/55/server')
          .send({ destinations: [destination, destination] })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app(Permission.ADMIN))
          .delete('/collection/55/server')
          .send({ destinations: [{ libraryId: '1' }] })
      ).status
    ).toBe(400);
  });
  it('passes the shared item selection through the real OpenAPI schema for creation only', async () => {
    expect(
      (
        await request(app(Permission.ADMIN))
          .post('/collection/55/server')
          .send({ libraryIds: ['1'], selectedIds: ['11'] })
      ).status
    ).toBe(200);
    expect(sync.checkCollection).toHaveBeenCalledWith(55, ['1'], undefined, {
      selectedIds: ['11'],
    });
    for (const selectedIds of [
      [],
      ['../11'],
      [11],
      Array.from({ length: 501 }, (_, index) => String(index + 1)),
    ]) {
      expect(
        (
          await request(app(Permission.ADMIN))
            .post('/collection/55/server')
            .send({ libraryIds: ['1'], selectedIds })
        ).status
      ).toBe(400);
    }
  });
});
