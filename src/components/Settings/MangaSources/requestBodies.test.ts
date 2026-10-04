import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HAS_CONTROL_CHARACTER as SERVER_HAS_CONTROL_CHARACTER } from '@server/api/suwayomi/mappers';

import {
  HAS_CONTROL_CHARACTER,
  bindByMangaId,
  bindBySource,
  isAnilistId,
  isInstanceId,
  isListStatus,
  isSourceId,
  isSourceUrl,
  resolveDetailKey,
  resolveListKey,
} from './requestBodies';

describe('manga source request helpers', () => {
  it('builds the list query from the page, page size and status', () => {
    assert.equal(resolveListKey(1, 10), '/api/v1/manga/resolve?take=10&skip=0');
    assert.equal(
      resolveListKey(3, 25, 'NEEDS_PICK'),
      '/api/v1/manga/resolve?take=25&skip=50&status=NEEDS_PICK'
    );
    assert.equal(
      resolveDetailKey(9001, 0),
      '/api/v1/manga/resolve/9001?instanceId=0'
    );
  });

  it('accepts instance ID 0 but no negative or fractional ID', () => {
    assert.equal(isInstanceId(0), true);
    assert.equal(isInstanceId(2_147_483_647), true);
    assert.equal(isInstanceId(2_147_483_648), false);
    assert.equal(isInstanceId(-1), false);
    assert.equal(isInstanceId(1.5), false);
    assert.equal(isAnilistId(0), false);
    assert.equal(isAnilistId(1), true);
    assert.equal(isListStatus('QUEUED'), true);
    assert.equal(isListStatus('BOUND'), false);
  });

  it('copies the server control-character check exactly', () => {
    assert.equal(
      HAS_CONTROL_CHARACTER.source,
      SERVER_HAS_CONTROL_CHARACTER.source
    );
    assert.equal(
      HAS_CONTROL_CHARACTER.flags,
      SERVER_HAS_CONTROL_CHARACTER.flags
    );
  });

  it('checks source IDs against the signed 64-bit range', () => {
    assert.equal(isSourceId('9223372036854775807'), true);
    assert.equal(isSourceId('9223372036854775808'), false);
    assert.equal(isSourceId('99999999999999999999'), false);
    assert.equal(isSourceId('1002'), true);
    assert.equal(isSourceId(''), false);
    assert.equal(isSourceId('-1'), false);
    assert.equal(isSourceId('10.2'), false);
  });

  it('checks URLs for length and control characters', () => {
    assert.equal(isSourceUrl('x'.repeat(2_048)), true);
    assert.equal(isSourceUrl('x'.repeat(2_049)), false);
    assert.equal(isSourceUrl(''), false);
    assert.equal(isSourceUrl('/manga/a\u0085b'), false);
    assert.equal(isSourceUrl('/manga/a\u007fb'), false);
    assert.equal(isSourceUrl('/manga/a\tb'), false);
    assert.equal(isSourceUrl('/manga/a\u00a0b'), true);
  });

  it('builds a bind by source with exactly its fields', () => {
    assert.deepEqual(bindBySource(0, '1002', '  /manga/synthetic-1\n'), {
      body: { instanceId: 0, sourceId: '1002', url: '/manga/synthetic-1' },
    });
    assert.deepEqual(bindBySource(0, '9223372036854775808', '/manga/1'), {
      problem: 'source',
    });
    assert.deepEqual(bindBySource(0, '1002', '   '), { problem: 'url' });
    assert.deepEqual(bindBySource(0, '1002', '/manga/\u0085'), {
      problem: 'url',
    });
  });

  it('builds a bind by manga ID with exactly its fields', () => {
    assert.deepEqual(bindByMangaId(0, ' 42 '), {
      body: { instanceId: 0, suwayomiMangaId: 42 },
    });
    for (const value of ['', '0', '-3', '1.5', '2147483648', '1e3', 'abc']) {
      assert.deepEqual(bindByMangaId(0, value), { problem: 'mangaId' }, value);
    }
  });
});
