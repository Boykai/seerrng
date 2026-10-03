import { Permission } from '@server/lib/permissions';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import ChooseSourceLink, { getMangaSourcesHref } from './ChooseSourceLink';

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
  state.granted = [Permission.ADMIN];
});

const render = (props: React.ComponentProps<typeof ChooseSourceLink>) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <ChooseSourceLink {...props} />
    </IntlProvider>
  );

it.each([
  [30013, 0],
  [1, 2147483647],
  [2147483647, 3],
])('opens the title with AniList ID %i on instance %i', (anilistId, id) => {
  expect(getMangaSourcesHref(anilistId, id)).toBe(
    `/settings/manga-sources?anilistId=${anilistId}&instanceId=${id}`
  );
});

it.each<[number | null | undefined, number | null | undefined]>([
  [0, 0],
  [-1, 0],
  [1.5, 0],
  [2147483648, 0],
  [Number.NaN, 0],
  [null, 0],
  [undefined, 0],
  [30013, -1],
  [30013, 0.5],
  [30013, 2147483648],
  [30013, null],
  [30013, undefined],
])('links nowhere for AniList ID %s on instance %s', (anilistId, id) => {
  expect(getMangaSourcesHref(anilistId, id)).toBeUndefined();
});

it('shows administrators a text link after a space', () => {
  expect(render({ anilistId: 30013, instanceId: 0 })).toBe(
    ' <a href="/settings/manga-sources?anilistId=30013&amp;instanceId=0" class="request-manga-source-link">Choose Source</a>'
  );
});

it('shows administrators a small Manage button with a hidden icon', () => {
  const markup = render({ anilistId: 30013, instanceId: 0, asButton: true });

  expect(markup).toMatch(
    /^<a href="\/settings\/manga-sources\?anilistId=30013&amp;instanceId=0" class="app-button app-button-manage button-sm"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg>Choose Source<\/a>$/
  );
  // The shared button-sm rule sizes the icon.
  expect(markup).not.toMatch(/<svg[^>]*class=/);
});

it.each([
  ['a request manager', [Permission.MANAGE_REQUESTS]],
  ['a user', [Permission.REQUEST]],
  ['a signed-out visitor', []],
])('shows %s nothing', (_case, granted) => {
  state.granted = granted;

  expect(render({ anilistId: 30013, instanceId: 0 })).toBe('');
  expect(render({ anilistId: 30013, instanceId: 0, asButton: true })).toBe('');
});

it('shows administrators nothing without both IDs', () => {
  expect(render({ anilistId: 30013 })).toBe('');
  expect(render({ instanceId: 0, asButton: true })).toBe('');
});
