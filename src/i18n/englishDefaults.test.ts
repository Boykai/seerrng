import enMessages from '@app/i18n/locale/en.json';
import { createIntl, createIntlCache } from 'react-intl';
import { expect, it } from 'vitest';

// Entries with tags but no `{` are left out: they are always formatted with
// values, so both paths go through ICU and cannot differ.
const plainEntries = Object.entries(
  enMessages as Record<string, string>
).filter(([, value]) => !value.includes('{') && !value.includes('<'));

it('formats every plain English message identically from defaults and from en.json', () => {
  const catalogueErrors: unknown[] = [];
  const defaultErrors: unknown[] = [];
  const fromCatalogue = createIntl(
    {
      locale: 'en',
      defaultLocale: 'en',
      messages: enMessages as Record<string, string>,
      onError: (error) => catalogueErrors.push(error),
    },
    createIntlCache()
  );
  const fromDefaults = createIntl(
    {
      locale: 'en',
      defaultLocale: 'en',
      messages: {},
      onError: (error) => defaultErrors.push(error),
    },
    createIntlCache()
  );

  expect(plainEntries.length).toBeGreaterThan(1000);
  const mismatches = plainEntries.filter(
    ([id, value]) =>
      fromDefaults.formatMessage({ id, defaultMessage: value }) !==
      fromCatalogue.formatMessage({ id, defaultMessage: value })
  );

  expect(mismatches).toEqual([]);
  expect(defaultErrors).toEqual([]);
  expect(catalogueErrors).toEqual([]);
});
