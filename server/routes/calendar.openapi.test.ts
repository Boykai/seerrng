import { parseCalendarQuery } from '@server/lib/releaseCalendar/query';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { it } from 'node:test';
import request from 'supertest';
function app() {
  const result = express();
  result.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  result.get('/api/v1/calendar', (req, res) => {
    const query = parseCalendarQuery(req.query, true, true);
    res.json({ scope: query.scope, unmonitored: query.includeUnmonitored });
  });
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
it('allows calendar dates and coerced boolean filters through the contract and parser', async () => {
  const response = await request(app()).get(
    '/api/v1/calendar?start=2026-09-01&end=2026-10-01&scope=all&includeUnmonitored=true'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { scope: 'all', unmonitored: true });
  const musicCalendar = await request(app()).get(
    '/api/v1/calendar?start=2026-09-01&end=2026-10-01&mediaType=music'
  );
  assert.equal(musicCalendar.status, 200);
});
it('rejects unknown calendar types and malformed booleans at the contract', async () => {
  assert.equal(
    (await request(app()).get('/api/v1/calendar?mediaType=unknown')).status,
    400
  );
  assert.equal(
    (await request(app()).get('/api/v1/calendar?includeUnmonitored=anything'))
      .status,
    400
  );
});
