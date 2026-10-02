import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import Sidebar from '.';

const state = vi.hoisted(() => ({
  pathname: '/',
  settings: {} as Record<string, unknown>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: state.pathname }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@app/components/Layout/VersionStatus', () => ({
  default: () => null,
}));
vi.mock('@app/hooks/useClickOutside', () => ({ default: () => undefined }));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useUser', () => ({
  Permission: { ADMIN: 2, MANAGE_REQUESTS: 32, MANAGE_ISSUES: 64 },
  useUser: () => ({ hasPermission: () => false }),
}));

const render = () =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <Sidebar
        open={false}
        setClosed={vi.fn()}
        pendingRequestsCount={0}
        openIssuesCount={0}
        revalidateIssueCount={vi.fn()}
        revalidateRequestsCount={vi.fn()}
      />
    </IntlProvider>
  );
const mangaLink = (html: string) =>
  html.match(/<a[^>]*href="\/discover\/manga"[^>]*>[\s\S]*?<\/a>/)?.[0];

beforeEach(() => {
  vi.stubGlobal('React', React);
  state.pathname = '/';
  state.settings = {
    musicEnabled: true,
    booksEnabled: true,
    comicsEnabled: true,
  };
});

it('hides the manga entry while the manga category is off or unset', () => {
  expect(mangaLink(render())).toBeUndefined();
  state.settings.enabledMediaCategories = { manga: false };
  expect(mangaLink(render())).toBeUndefined();
  expect(render()).toContain('href="/discover/comics"');
});

it('shows the manga entry and marks it active on manga pages', () => {
  state.settings.enabledMediaCategories = { manga: true };
  expect(mangaLink(render())).toContain('>Manga</a>');
  expect(mangaLink(render())).toContain('sidebar-link-idle');
  state.pathname = '/manga/[mangaId]';
  expect(mangaLink(render())).toContain('sidebar-link-selected');
  state.pathname = '/discover/manga';
  expect(mangaLink(render())).toContain('sidebar-link-selected');
  state.pathname = '/discover/comics';
  expect(mangaLink(render())).toContain('sidebar-link-idle');
});
