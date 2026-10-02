import type { SuwayomiSettings } from '@server/lib/settings';
import { REDACTED_SECRET, redactSecrets } from '@server/utils/security';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  MAX_SUWAYOMI_ALLOWLIST_SOURCES,
  MAX_SUWAYOMI_PASSWORD_LENGTH,
  buildSuwayomiUrl,
  checkSuwayomiCredentials,
  parseSuwayomiConnectionTest,
  parseSuwayomiSettings,
  resolveSuwayomiPassword,
  suwayomiSettingsView,
} from './suwayomiSettings';

const PASSWORD = randomUUID();

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Suwayomi',
  hostname: 'suwayomi.local',
  port: 4567,
  useSsl: false,
  authMode: 'UI_LOGIN',
  username: 'fake-user',
  password: PASSWORD,
  ...overrides,
});

const stored = (
  overrides: Partial<SuwayomiSettings> = {}
): SuwayomiSettings => ({
  id: 0,
  name: 'Suwayomi',
  hostname: 'suwayomi.local',
  port: 4567,
  useSsl: false,
  isDefault: true,
  authMode: 'UI_LOGIN',
  username: 'fake-user',
  password: PASSWORD,
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
  ...overrides,
});

const parsed = (input: unknown) => {
  const result = parseSuwayomiSettings(input);
  assert.ok('value' in result, JSON.stringify(result));
  return result.value;
};

const rejected = (input: unknown) => {
  const result = parseSuwayomiSettings(input);
  assert.ok('error' in result, JSON.stringify(input));
  return result;
};

describe('parseSuwayomiSettings', () => {
  it('parses a complete body and applies defaults', () => {
    assert.deepEqual(parsed(body({ id: 7, isDefault: false, extra: 1 })), {
      name: 'Suwayomi',
      hostname: 'suwayomi.local',
      port: 4567,
      useSsl: false,
      baseUrl: undefined,
      authMode: 'UI_LOGIN',
      username: 'fake-user',
      password: PASSWORD,
      sourceAllowlist: [],
      preferredLanguages: [],
      scanlatorPreference: [],
      requireCbz: true,
    });
  });

  it('keeps credentials exactly as entered', () => {
    const value = parsed(
      body({ username: ' fake-user ', password: ` ${PASSWORD} ` })
    );
    assert.equal(value.username, ' fake-user ');
    assert.equal(value.password, ` ${PASSWORD} `);
  });

  it('rejects line breaks, NUL characters and oversized credentials', () => {
    for (const value of ['a\rb', 'a\nb', 'a\0b']) {
      rejected(body({ password: value }));
      rejected(body({ username: value }));
    }
    rejected(body({ password: 'x'.repeat(MAX_SUWAYOMI_PASSWORD_LENGTH + 1) }));
    rejected(body({ password: 5 }));
  });

  it('requires a credential for the modes that sign in', () => {
    for (const authMode of ['UI_LOGIN', 'BASIC_AUTH']) {
      const result = rejected(body({ authMode, username: '', password: '' }));
      assert.equal(result.code, 'SUWAYOMI_CREDENTIALS_REQUIRED');
    }
    assert.equal(
      parsed(body({ authMode: 'NONE', username: '', password: '' })).authMode,
      'NONE'
    );
    assert.equal(
      checkSuwayomiCredentials('UI_LOGIN', 'fake-user', ''),
      undefined
    );
  });

  it('accepts only the supported authentication modes', () => {
    for (const authMode of ['SIMPLE_LOGIN', 'ui_login', '', undefined]) {
      assert.equal(
        rejected(body({ authMode })).code,
        'SUWAYOMI_INVALID_SETTINGS'
      );
    }
  });

  it('validates the server address', () => {
    rejected(body({ hostname: '' }));
    rejected(body({ hostname: 'http://suwayomi.local' }));
    rejected(body({ hostname: '127.0.0.1:4567' }));
    rejected(body({ port: 0 }));
    rejected(body({ port: 65_536 }));
    rejected(body({ useSsl: 'yes' }));
    rejected(body({ baseUrl: 'https://elsewhere.example' }));
    assert.equal(parsed(body({ baseUrl: 'manga/' })).baseUrl, '/manga');
    assert.equal(parsed(body({ hostname: '[::1]' })).hostname, '[::1]');
  });

  it('keeps source IDs as canonical 64-bit strings in admin order', () => {
    const ids = ['9223372036854775807', '4000000000000000001', '12'];
    assert.deepEqual(
      parsed(body({ sourceAllowlist: [...ids, ids[0]] })).sourceAllowlist,
      ids
    );
    for (const id of ['0', '012', '-1', '9223372036854775808', '1.5', 12, '']) {
      rejected(body({ sourceAllowlist: [id] }));
    }
    rejected(
      body({
        sourceAllowlist: Array.from(
          { length: MAX_SUWAYOMI_ALLOWLIST_SOURCES + 1 },
          (_, index) => String(index + 1)
        ),
      })
    );
  });

  it('parses language and scanlator preferences', () => {
    const value = parsed(
      body({
        preferredLanguages: ['en', 'pt-BR', 'en'],
        scanlatorPreference: [' Group A ', 'Group B', 'Group A'],
      })
    );
    assert.deepEqual(value.preferredLanguages, ['en', 'pt-BR']);
    assert.deepEqual(value.scanlatorPreference, ['Group A', 'Group B']);
    rejected(body({ preferredLanguages: ['en us'] }));
    rejected(body({ scanlatorPreference: ['  '] }));
    rejected(body({ scanlatorPreference: ['Group\u0007A'] }));
    rejected(body({ preferredLanguages: 'en' }));
  });

  it('defaults requireCbz to true and rejects non-booleans', () => {
    assert.equal(parsed(body({ requireCbz: false })).requireCbz, false);
    assert.equal(parsed(body({ requireCbz: null })).requireCbz, true);
    rejected(body({ requireCbz: 'false' }));
  });

  it('rejects bodies that are not objects', () => {
    rejected([]);
    rejected(null);
    rejected('settings');
  });
});

describe('parseSuwayomiConnectionTest', () => {
  it('ignores the mode and keeps the instance ID', () => {
    const result = parseSuwayomiConnectionTest(
      body({ id: 3, authMode: 'SIMPLE_LOGIN', name: undefined })
    );
    assert.ok('value' in result);
    assert.deepEqual(result.value, {
      id: 3,
      hostname: 'suwayomi.local',
      port: 4567,
      useSsl: false,
      baseUrl: undefined,
      username: 'fake-user',
      password: PASSWORD,
      requireCbz: true,
      sourceAllowlist: [],
    });
  });

  it('rejects invalid IDs and addresses', () => {
    for (const input of [
      body({ id: -1 }),
      body({ id: 'one' }),
      body({ hostname: '' }),
      body({ sourceAllowlist: ['0'] }),
    ]) {
      assert.ok('error' in parseSuwayomiConnectionTest(input));
    }
  });
});

describe('resolveSuwayomiPassword', () => {
  const incoming = (overrides: Record<string, unknown> = {}) => {
    const result = parseSuwayomiConnectionTest(
      body({ password: REDACTED_SECRET, ...overrides })
    );
    assert.ok('value' in result);
    return result.value;
  };

  it('passes a typed password through', () => {
    assert.deepEqual(
      resolveSuwayomiPassword(incoming({ password: 'typed' }), undefined),
      { value: 'typed' }
    );
  });

  it('reuses the stored password for the same address and username', () => {
    assert.deepEqual(resolveSuwayomiPassword(incoming(), stored()), {
      value: PASSWORD,
    });
    assert.deepEqual(
      resolveSuwayomiPassword(
        incoming({ baseUrl: '/manga' }),
        stored({ baseUrl: '/manga' })
      ),
      { value: PASSWORD }
    );
  });

  it('requires the password again after the address or username changes', () => {
    const changes: Record<string, unknown>[] = [
      { useSsl: true },
      { hostname: 'elsewhere.local' },
      { port: 4568 },
      { baseUrl: '/manga' },
      { username: 'other-user' },
    ];
    for (const change of changes) {
      const result = resolveSuwayomiPassword(incoming(change), stored());
      assert.ok('error' in result, JSON.stringify(change));
      assert.equal(result.code, 'SUWAYOMI_PASSWORD_REQUIRED');
    }
    const missing = resolveSuwayomiPassword(incoming(), undefined);
    assert.ok('error' in missing);
    assert.equal(missing.code, 'SUWAYOMI_PASSWORD_REQUIRED');
  });
});

describe('suwayomiSettingsView', () => {
  it('never returns the stored password', () => {
    const view = suwayomiSettingsView(
      stored({ sourceAllowlist: ['4000000000000000001'] })
    );
    assert.equal(view.password, REDACTED_SECRET);
    assert.ok(!JSON.stringify(view).includes(PASSWORD));
    assert.deepEqual(redactSecrets(view), view);
    assert.deepEqual(Object.keys(view).sort(), [
      'authMode',
      'baseUrl',
      'hostname',
      'id',
      'isDefault',
      'name',
      'password',
      'port',
      'preferredLanguages',
      'requireCbz',
      'scanlatorPreference',
      'sourceAllowlist',
      'useSsl',
      'username',
    ]);
  });

  it('shows an empty password when none is stored', () => {
    const view = suwayomiSettingsView(
      stored({ authMode: 'NONE', username: '', password: '' })
    );
    assert.equal(view.password, '');
    assert.deepEqual(redactSecrets(view), view);
  });

  it('builds the server URL from the address fields', () => {
    assert.equal(
      buildSuwayomiUrl({
        hostname: 'suwayomi.local',
        port: 4567,
        useSsl: true,
        baseUrl: '/manga',
      }),
      'https://suwayomi.local:4567/manga'
    );
  });
});
