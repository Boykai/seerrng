import { MangaRequestScope } from '@server/constants/mangaRequest';
import { Permission } from '@server/lib/permissions';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider, createIntl } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import { MangaWaitingHint, MangaWaitingStatus, formatMangaScope } from '.';

const state = vi.hoisted(() => ({ granted: [] as number[] }));
vi.mock('next/link', () => ({
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children: React.ReactNode;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      hasPermission: (required: number) => state.granted.includes(required),
    }),
  };
});

beforeEach(() => {
  vi.stubGlobal('React', React);
  state.granted = [];
});

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

const hint =
  'SeerrNG is looking for a source; an administrator may need to choose one.';
const renderStatus = (props: Parameters<typeof MangaWaitingStatus>[0]) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <MangaWaitingStatus {...props} />
    </IntlProvider>
  );

it.each([1, 0])(
  'links administrators from the hint to the title on instance %i',
  (instanceId) => {
    state.granted = [Permission.ADMIN];

    expect(
      renderStatus({ showHint: true, anilistId: 30013, instanceId })
    ).toContain(
      `<span class="text-xs">${hint} <a href="/settings/manga-sources?anilistId=30013&amp;instanceId=${instanceId}" class="request-manga-source-link">Choose Source</a></span>`
    );
  }
);

it.each([
  ['a request manager', [Permission.MANAGE_REQUESTS], 30013, 0],
  ['a missing AniList ID', [Permission.ADMIN], undefined, 0],
  ['a null AniList ID', [Permission.ADMIN], null, 0],
  ['a missing instance', [Permission.ADMIN], 30013, undefined],
  ['a null instance', [Permission.ADMIN], 30013, null],
])('keeps the plain hint for %s', (_case, granted, anilistId, instanceId) => {
  state.granted = granted;

  const markup = renderStatus({ showHint: true, anilistId, instanceId });

  expect(markup).toContain(`<span class="text-xs">${hint}</span>`);
  expect(markup).not.toContain('<a');
});

it('links nothing while the hint is hidden', () => {
  state.granted = [Permission.ADMIN];

  expect(renderStatus({ anilistId: 30013, instanceId: 0 })).not.toContain(
    'Choose Source'
  );
});

it('keeps the classes a caller gives the hint', () => {
  state.granted = [Permission.ADMIN];

  expect(
    renderToStaticMarkup(
      <IntlProvider locale="en">
        <MangaWaitingHint
          className="text-xs whitespace-normal"
          anilistId={30013}
          instanceId={2}
        />
      </IntlProvider>
    )
  ).toBe(
    `<span class="text-xs whitespace-normal">${hint} <a href="/settings/manga-sources?anilistId=30013&amp;instanceId=2" class="request-manga-source-link">Choose Source</a></span>`
  );
});
