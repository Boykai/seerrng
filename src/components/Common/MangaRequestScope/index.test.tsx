import { MangaRequestScope } from '@server/constants/mangaRequest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider, createIntl } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import { MangaWaitingStatus, formatMangaScope } from '.';

beforeEach(() => vi.stubGlobal('React', React));

const intl = createIntl({ locale: 'en' });
const scope = (
  values: Partial<Parameters<typeof formatMangaScope>[1] & object>
) => ({
  scope: MangaRequestScope.ALL_AT_DISPATCH,
  latestCount: null,
  rangeStart: null,
  rangeEnd: null,
  ...values,
});

it.each([
  ['no scope', undefined, 'All'],
  ['every chapter', scope({}), 'All'],
  [
    'one latest chapter',
    scope({ scope: MangaRequestScope.LATEST_N, latestCount: 1 }),
    'Latest 1',
  ],
  [
    'the latest chapters',
    scope({ scope: MangaRequestScope.LATEST_N, latestCount: 2500 }),
    'Latest 2,500',
  ],
  [
    'a closed range',
    scope({ scope: MangaRequestScope.RANGE, rangeStart: 10, rangeEnd: 20 }),
    '10–20',
  ],
  [
    'a decimal range',
    scope({
      scope: MangaRequestScope.RANGE,
      rangeStart: 0.5,
      rangeEnd: 1000000,
    }),
    '0.5–1,000,000',
  ],
  [
    'an open range',
    scope({ scope: MangaRequestScope.RANGE, rangeStart: 10 }),
    '10 onward',
  ],
  [
    'a range from chapter 0',
    scope({ scope: MangaRequestScope.RANGE, rangeStart: 0 }),
    '0 onward',
  ],
])('summarizes %s', (_case, value, expected) => {
  expect(formatMangaScope(intl, value)).toBe(expected);
});

it('shows the hint for the waiting status only when asked', () => {
  const render = (showHint?: boolean) =>
    renderToStaticMarkup(
      <IntlProvider locale="en">
        <MangaWaitingStatus showHint={showHint} />
      </IntlProvider>
    );

  expect(render()).toContain('Waiting for a source');
  expect(render()).not.toContain('administrator');
  expect(render(true)).toContain(
    'SeerrNG is looking for a source; an administrator may need to choose one.'
  );
});
