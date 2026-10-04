import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DiscoveryAccounts from './Accounts';

const state = vi.hoisted(() => ({
  accounts: [] as Record<string, unknown>[],
  enabledMediaCategories: { manga: true } as Record<string, boolean>,
  put: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('swr', () => ({
  default: (key: string) =>
    key.endsWith('/accounts')
      ? { data: { accounts: state.accounts }, mutate: state.mutate }
      : {
          data: {
            trakt: { configured: true },
            anilist: { configured: true },
            simkl: { configured: true },
          },
        },
}));
vi.mock('axios', () => ({ default: { put: state.put } }));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { enabledMediaCategories: state.enabledMediaCategories },
  }),
}));
vi.mock(
  '@app/components/DiscoveryIntegrations/CuratedIdentityPackControls',
  () => ({ default: () => null })
);

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.accounts = [
    { provider: 'trakt', username: 'sample-trakt', allowWrites: false },
    {
      provider: 'anilist',
      username: 'sample-anilist',
      allowWrites: false,
      importMangaPlanning: false,
    },
  ];
  state.enabledMediaCategories = { manga: true };
  state.put.mockReset().mockResolvedValue({ status: 204 });
  state.mutate.mockReset().mockResolvedValue(undefined);
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
        <DiscoveryAccounts />
      </IntlProvider>
    )
  );
};

const importToggles = () =>
  [...host.querySelectorAll('label')].filter((label) =>
    label.textContent?.includes('AniList Planning list')
  );

it('offers the Planning manga import only on the AniList account', async () => {
  await render();

  const toggles = importToggles();
  expect(toggles).toHaveLength(1);
  expect(toggles[0].closest('div')?.textContent).toContain('sample-anilist');
  expect(toggles[0].textContent).toContain('never changes it');
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
});

it('hides the Planning manga import while manga is disabled', async () => {
  state.enabledMediaCategories = { manga: false };
  await render();

  expect(importToggles()).toHaveLength(0);
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
});

it('saves the Planning manga import preference on its own', async () => {
  await render();
  await act(async () => {
    importToggles()[0].querySelector('input')!.click();
  });

  expect(state.put).toHaveBeenCalledTimes(1);
  expect(state.put).toHaveBeenCalledWith(
    '/api/v1/integrations/discovery/accounts/anilist/preferences',
    { importMangaPlanning: true }
  );
  expect(state.mutate).toHaveBeenCalled();
});

it('keeps saving the tracking-write preference unchanged', async () => {
  state.accounts[1].importMangaPlanning = true;
  await render();
  expect(importToggles()[0].querySelector('input')!.checked).toBe(true);

  const writes = [...host.querySelectorAll('label')].find(
    (label) =>
      label.textContent?.includes('tracking changes to my AniList') ?? false
  )!;
  await act(async () => {
    writes.querySelector('input')!.click();
  });

  expect(state.put).toHaveBeenCalledWith(
    '/api/v1/integrations/discovery/accounts/anilist/preferences',
    { allowWrites: true }
  );
});
