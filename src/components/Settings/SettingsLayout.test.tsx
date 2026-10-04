import SettingsLayout from '@app/components/Settings/SettingsLayout';
import type * as UseUser from '@app/hooks/useUser';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  admin: true,
  pathname: '/settings/manga-library',
  settings: {} as Record<string, unknown>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({
    pathname: state.pathname,
    asPath: state.pathname,
    beforePopState: () => undefined,
    push: () => Promise.resolve(true),
  }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useUser', async (importOriginal) => ({
  ...(await importOriginal<typeof UseUser>()),
  useUser: () => ({ hasPermission: () => state.admin }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/Header', () => ({ default: () => null }));
vi.mock('@app/components/Common/Modal', () => ({ default: () => null }));
vi.mock('@app/components/Common/SettingsTabs', () => ({
  default: ({
    settingsRoutes,
  }: {
    settingsRoutes: { text: string; route: string }[];
  }) => (
    <nav>
      {settingsRoutes.map(({ text, route }) => (
        <span key={route} data-route={route}>
          {text}
        </span>
      ))}
    </nav>
  ),
}));

let dom: JSDOM;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.admin = true;
  state.pathname = '/settings/manga-library';
  state.settings = {
    enabledMediaCategories: { manga: true },
    suwayomiEnabled: true,
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <SettingsLayout>
          <div />
        </SettingsLayout>
      </IntlProvider>
    )
  );
};

const routes = () =>
  [...host.querySelectorAll('[data-route]')].map((tab) =>
    tab.getAttribute('data-route')
  );

describe('SettingsLayout', () => {
  it('lists Manga Library after Library Migration for admins with Suwayomi', async () => {
    await render();

    const index = routes().indexOf('/settings/manga-library');
    expect(index).toBeGreaterThan(0);
    expect(routes()[index - 1]).toBe('/settings/library-migration');
    expect(
      host.querySelector('[data-route="/settings/manga-library"]')?.textContent
    ).toBe('Manga Library');
    // The review screen saves each decision itself.
    expect(
      host.querySelector('[data-testid="settings-save-button"]')
    ).toBeNull();
  });

  it('lists Manga Sources right after Manga Library', async () => {
    state.pathname = '/settings/manga-sources';
    await render();

    const index = routes().indexOf('/settings/manga-sources');
    expect(index).toBeGreaterThan(0);
    expect(routes()[index - 1]).toBe('/settings/manga-library');
    expect(
      host.querySelector('[data-route="/settings/manga-sources"]')?.textContent
    ).toBe('Manga Sources');
    // Each pick saves itself.
    expect(
      host.querySelector('[data-testid="settings-save-button"]')
    ).toBeNull();
  });

  it.each([
    ['the manga category is off', { manga: false }, true, true],
    ['Suwayomi is not configured', { manga: true }, false, true],
    ['the user is not an admin', { manga: true }, true, false],
  ])(
    'hides Manga Library and Manga Sources while %s',
    async (_, enabledMediaCategories, suwayomiEnabled, admin) => {
      state.settings = { enabledMediaCategories, suwayomiEnabled };
      state.admin = admin;
      state.pathname = '/settings/main';
      await render();

      expect(routes()).not.toContain('/settings/manga-library');
      expect(routes()).not.toContain('/settings/manga-sources');
      expect(routes()).toContain('/settings/jobs');
    }
  );
});
