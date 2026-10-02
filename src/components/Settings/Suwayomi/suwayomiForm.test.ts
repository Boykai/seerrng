import {
  authModeBadgeType,
  buildSaveRequest,
  buildTestRequest,
  clearsStoredPassword,
  describeSuwayomiError,
  filterSourceEntries,
  hasLineBreak,
  isSettingsAuthMode,
  isValidHostname,
  isValidLanguageList,
  isValidPort,
  isValidScanlatorList,
  isValidSourceId,
  isValidUrlBase,
  orderSourceEntries,
  parseLanguages,
  parseScanlators,
  readSuwayomiError,
  readTestDiagnostics,
  readTestFailure,
  readTestSources,
  resetsValidation,
  showsSourceLanguage,
  SUWAYOMI_MAX_SOURCES,
  suwayomiFormValues,
  toggleSourceId,
  type SuwayomiFormValues,
} from '@app/components/Settings/Suwayomi/suwayomiForm';
import { REDACTED_SECRET } from '@app/utils/secret';
import type {
  SuwayomiConnectionTestSource,
  SuwayomiSettingsView,
} from '@server/interfaces/api/suwayomiInterfaces';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';

const view: SuwayomiSettingsView = {
  id: 1,
  name: 'Suwayomi',
  hostname: 'suwayomi.test',
  port: 4567,
  useSsl: false,
  baseUrl: '/manga',
  isDefault: true,
  authMode: 'UI_LOGIN',
  username: 'reader',
  password: REDACTED_SECRET,
  sourceAllowlist: ['1001', '0', '1002'],
  preferredLanguages: ['en', 'ja'],
  scanlatorPreference: ['Group One', 'Group Two'],
  requireCbz: true,
};

const source = (
  id: string,
  displayName: string,
  lang = 'en',
  extra: Partial<SuwayomiConnectionTestSource> = {}
): SuwayomiConnectionTestSource => ({
  id,
  name: displayName,
  displayName,
  lang,
  contentWarning: 'SAFE',
  hasUpdate: false,
  isObsolete: false,
  ...extra,
});

const values = (
  overrides: Partial<SuwayomiFormValues> = {}
): SuwayomiFormValues => ({ ...suwayomiFormValues(view), ...overrides });

const axiosError = (data: unknown) => ({ response: { status: 502, data } });

describe('form values', () => {
  it('starts a new server with the defaults', () => {
    expect(suwayomiFormValues(null)).toEqual({
      name: '',
      hostname: '',
      port: 4567,
      useSsl: false,
      baseUrl: '',
      username: '',
      password: '',
      requireCbz: true,
      sourceAllowlist: [],
      preferredLanguages: '',
      scanlatorPreference: '',
    });
  });

  it('loads a stored server and drops source ids the API never stores', () => {
    expect(suwayomiFormValues(view)).toMatchObject({
      password: REDACTED_SECRET,
      sourceAllowlist: ['1001', '1002'],
      preferredLanguages: 'en, ja',
      scanlatorPreference: 'Group One\nGroup Two',
    });
  });

  it('resets validation only for fields the test depends on', () => {
    for (const field of [
      'useSsl',
      'hostname',
      'port',
      'baseUrl',
      'username',
      'password',
      'requireCbz',
    ] as const) {
      expect(resetsValidation(field)).toBe(true);
    }
    for (const field of [
      'name',
      'sourceAllowlist',
      'preferredLanguages',
      'scanlatorPreference',
    ] as const) {
      expect(resetsValidation(field)).toBe(false);
    }
  });

  it('clears a stored password only when the address or username changes', () => {
    for (const field of [
      'useSsl',
      'hostname',
      'port',
      'baseUrl',
      'username',
    ] as const) {
      expect(clearsStoredPassword(field)).toBe(true);
    }
    for (const field of ['password', 'requireCbz', 'name'] as const) {
      expect(clearsStoredPassword(field)).toBe(false);
    }
  });
});

describe('field rules', () => {
  it('accepts decimal source ids within the signed 64-bit range', () => {
    expect(isValidSourceId('1')).toBe(true);
    expect(isValidSourceId('9223372036854775807')).toBe(true);
    for (const id of ['0', '01', '-1', '1.5', '9223372036854775808', 1]) {
      expect(isValidSourceId(id)).toBe(false);
    }
    expect(isValidSourceId('1'.repeat(20))).toBe(false);
  });

  it('accepts ports from 1 to 65535', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort('65535')).toBe(true);
    for (const port of [0, '65536', '', 'abc', '1.5', undefined]) {
      expect(isValidPort(port)).toBe(false);
    }
  });

  it('accepts a bare hostname and rejects schemes, ports and paths', () => {
    expect(isValidHostname({ hostname: 'suwayomi.test', port: 4567 })).toBe(
      true
    );
    expect(isValidHostname({ hostname: ' 127.0.0.1 ', port: '4567' })).toBe(
      true
    );
    for (const hostname of [
      '',
      '   ',
      'http://suwayomi.test',
      'suwayomi.test:4567',
      'suwayomi.test/manga',
      'user@suwayomi.test',
      'a'.repeat(513),
    ]) {
      expect(isValidHostname({ hostname, port: 4567 })).toBe(false);
    }
  });

  it('accepts an empty or relative URL base', () => {
    expect(isValidUrlBase('')).toBe(true);
    expect(isValidUrlBase('/manga')).toBe(true);
    expect(isValidUrlBase('manga/')).toBe(true);
    for (const urlBase of ['/', 'https://suwayomi.test', '//manga', '/a?b']) {
      expect(isValidUrlBase(urlBase)).toBe(false);
    }
  });

  it('finds line breaks in credentials', () => {
    expect(hasLineBreak('reader')).toBe(false);
    expect(hasLineBreak(undefined)).toBe(false);
    expect(hasLineBreak('read\ner')).toBe(true);
    expect(hasLineBreak('read\rer')).toBe(true);
  });

  it('parses language and scanlator lists without blanks or repeats', () => {
    expect(parseLanguages(' en, ja,, en ,zh-Hans ')).toEqual([
      'en',
      'ja',
      'zh-Hans',
    ]);
    expect(parseScanlators('Group One\n\n Group Two \nGroup One')).toEqual([
      'Group One',
      'Group Two',
    ]);
  });

  it('limits the language and scanlator lists', () => {
    expect(isValidLanguageList('en, ja')).toBe(true);
    expect(isValidLanguageList('e n')).toBe(false);
    expect(
      isValidLanguageList(Array.from({ length: 51 }, (_, i) => `l${i}`).join())
    ).toBe(false);
    expect(isValidScanlatorList('Group One\nGroup Two')).toBe(true);
    expect(isValidScanlatorList('x'.repeat(129))).toBe(false);
    expect(isValidScanlatorList('Group\tOne')).toBe(false);
    expect(
      isValidScanlatorList(
        Array.from({ length: 51 }, (_, i) => `Group ${i}`).join('\n')
      )
    ).toBe(false);
  });
});

describe('requests', () => {
  it('tests only the connection fields, with the id when editing', () => {
    const request = buildTestRequest(
      values({ hostname: ' suwayomi.test ', port: '4568', baseUrl: ' /m ' }),
      1
    );
    expect(request).toEqual({
      id: 1,
      hostname: 'suwayomi.test',
      port: 4568,
      useSsl: false,
      baseUrl: '/m',
      username: 'reader',
      password: REDACTED_SECRET,
      requireCbz: true,
      sourceAllowlist: ['1001', '1002'],
    });
    expect(buildTestRequest(values())).not.toHaveProperty('id');
  });

  it('saves without the id and default flag the API assigns', () => {
    const request = buildSaveRequest(values({ name: ' Manga ' }), 'BASIC_AUTH');
    expect(request).toEqual({
      name: 'Manga',
      hostname: 'suwayomi.test',
      port: 4567,
      useSsl: false,
      baseUrl: '/manga',
      authMode: 'BASIC_AUTH',
      username: 'reader',
      password: REDACTED_SECRET,
      sourceAllowlist: ['1001', '1002'],
      preferredLanguages: ['en', 'ja'],
      scanlatorPreference: ['Group One', 'Group Two'],
      requireCbz: true,
    });
    expect(request).not.toHaveProperty('id');
    expect(request).not.toHaveProperty('isDefault');
  });
});

describe('source picker', () => {
  const sources = [
    source('3', 'Source C', 'en', { name: 'Third' }),
    source('1', 'Source A (EN)', 'en'),
    source('2', 'Source B', 'ja'),
  ];

  it('appends selections in priority order and removes deselections', () => {
    expect(toggleSourceId(['2'], '1')).toEqual(['2', '1']);
    expect(toggleSourceId(['2', '1'], '2')).toEqual(['1']);
    expect(toggleSourceId(['2'], '0')).toEqual(['2']);
  });

  it(`caps the selection at ${SUWAYOMI_MAX_SOURCES} sources`, () => {
    const full = Array.from({ length: SUWAYOMI_MAX_SOURCES }, (_, i) =>
      String(i + 1)
    );
    expect(toggleSourceId(full, '999')).toEqual(full);
    expect(toggleSourceId(full, '1')).toHaveLength(SUWAYOMI_MAX_SOURCES - 1);
  });

  it('lists selected sources by priority, then the rest by name', () => {
    const entries = orderSourceEntries(sources, ['2', '9']);
    expect(entries.map(({ id, priority }) => [id, priority])).toEqual([
      ['2', 1],
      ['9', 2],
      ['1', undefined],
      ['3', undefined],
    ]);
    expect(entries[1].source).toBeUndefined();
  });

  it('lists stored sources before a test loads their names', () => {
    expect(orderSourceEntries(undefined, ['2', '1'])).toEqual([
      { id: '2', source: undefined, priority: 1 },
      { id: '1', source: undefined, priority: 2 },
    ]);
  });

  it('filters on display name, name and language without case', () => {
    const entries = orderSourceEntries(sources, ['9']);
    const ids = (query: string) =>
      filterSourceEntries(entries, query).map(({ id }) => id);
    expect(ids('source b')).toEqual(['2']);
    expect(ids('THIRD')).toEqual(['3']);
    expect(ids('JA')).toEqual(['2']);
    expect(ids('9')).toEqual(['9']);
    expect(ids('  ')).toEqual(['9', '1', '2', '3']);
  });

  it('shows the language unless the display name already does', () => {
    expect(showsSourceLanguage(source('1', 'Source A (EN)', 'en'))).toBe(false);
    expect(showsSourceLanguage(source('2', 'Source B', 'ja'))).toBe(true);
    expect(showsSourceLanguage(source('3', 'Source C', ''))).toBe(false);
  });
});

describe('responses', () => {
  const intl = createIntl({ locale: 'en' });
  const fallback = { id: 'test.fallback', defaultMessage: 'Fallback.' };

  it('keeps only the code and fixed message of an error', () => {
    expect(
      readSuwayomiError(
        axiosError({
          code: 'SUWAYOMI_AUTH_FAILED',
          message: 'Fixed.',
          detail: 'token-123',
        })
      )
    ).toEqual({ code: 'SUWAYOMI_AUTH_FAILED', message: 'Fixed.' });
    expect(
      readSuwayomiError(axiosError({ message: 'Validator text', errors: [] }))
    ).toEqual({});
    expect(readSuwayomiError(axiosError({ code: 7 }))).toEqual({});
    expect(readSuwayomiError(new Error('Network Error'))).toEqual({});
  });

  it('describes known codes in the locale and nothing upstream', () => {
    expect(
      describeSuwayomiError(
        intl,
        { code: 'SUWAYOMI_IN_USE', message: 'Upstream text' },
        fallback
      )
    ).toBe('Suwayomi is used by active manga requests and cannot be deleted.');
    expect(
      describeSuwayomiError(
        intl,
        { code: 'SUWAYOMI_FUTURE', message: 'Fixed English.' },
        fallback
      )
    ).toBe('Fixed English.');
    expect(
      describeSuwayomiError(intl, { code: 'SUWAYOMI_FUTURE' }, fallback)
    ).toBe('Fallback.');
    expect(describeSuwayomiError(intl, {}, fallback)).toBe('Fallback.');
  });

  it('recognises the auth modes that can be saved', () => {
    expect(isSettingsAuthMode('UI_LOGIN')).toBe(true);
    expect(isSettingsAuthMode('NONE')).toBe(true);
    expect(isSettingsAuthMode('SIMPLE_LOGIN')).toBe(false);
    expect(isSettingsAuthMode(undefined)).toBe(false);
    expect(authModeBadgeType.NONE).toBe('danger');
    expect(authModeBadgeType.UI_LOGIN).toBe('success');
  });

  it('keeps known diagnostics in the order the API sent them', () => {
    expect(
      readTestDiagnostics({
        authMode: 'NONE',
        version: 'v2.4.2366',
        warnings: [
          { code: 'AUTH_DISABLED' },
          { code: 'NOT_A_WARNING' },
          { code: 'QUEUE_ERRORS', count: 2 },
          { code: 'SOURCE_OBSOLETE', sourceIds: ['3', 'x', '0'] },
          'AUTH_DISABLED',
        ],
      })
    ).toEqual({
      authMode: 'NONE',
      version: 'v2.4.2366',
      warnings: [
        { code: 'AUTH_DISABLED' },
        { code: 'QUEUE_ERRORS', count: 2 },
        { code: 'SOURCE_OBSOLETE', sourceIds: ['3'] },
      ],
    });
    expect(
      readTestDiagnostics({
        authMode: 'SOMETHING_ELSE',
        version: 'v1 <script>',
        warnings: [{ code: 'QUEUE_ERRORS', count: 1.5 }],
      })
    ).toEqual({ warnings: [{ code: 'QUEUE_ERRORS' }] });
  });

  it('keeps well-formed sources only', () => {
    expect(
      readTestSources({
        sources: [
          {
            id: '1',
            name: 'A',
            displayName: 'Source A',
            lang: 'en',
            contentWarning: 'NSFW',
            hasUpdate: true,
            isObsolete: 'yes',
          },
          { id: '0', name: 'Local', displayName: 'Local', lang: '' },
          { id: '2', name: 'B', lang: 'ja' },
          {
            id: '3',
            name: 'C',
            displayName: 'Source C',
            lang: 'en',
            contentWarning: 'OTHER',
          },
        ],
      })
    ).toEqual([
      source('1', 'Source A', 'en', {
        name: 'A',
        contentWarning: 'NSFW',
        hasUpdate: true,
      }),
      source('3', 'Source C', 'en', { name: 'C', contentWarning: 'UNKNOWN' }),
    ]);
    expect(readTestSources({ sources: 'none' })).toEqual([]);
  });

  it('reads the diagnostics of a failed test only', () => {
    expect(
      readTestFailure(
        axiosError({
          success: false,
          code: 'SUWAYOMI_UNSUPPORTED_SERVER',
          message: 'Fixed.',
          version: 'v2.0.1',
          missingFields: ['someField'],
          warnings: [{ code: 'BELOW_PINNED_REVISION' }],
        })
      )
    ).toEqual({
      version: 'v2.0.1',
      warnings: [{ code: 'BELOW_PINNED_REVISION' }],
    });
    expect(
      readTestFailure(axiosError({ code: 'SUWAYOMI_INVALID_SETTINGS' }))
    ).toBeUndefined();
    expect(readTestFailure(new Error('Network Error'))).toBeUndefined();
  });
});
