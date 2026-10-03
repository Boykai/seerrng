import { MediaServerType } from '@server/constants/server';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UserGeneralSettings from '.';

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  post: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('swr', () => ({
  default: (key: string | null) =>
    key?.startsWith('/api/v1/user/')
      ? { data: state.data, error: undefined, mutate: state.revalidate }
      : { data: [] },
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: { userId: '9' } }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  const user = await import('@server/constants/user');
  return {
    Permission: permissions.Permission,
    UserType: user.UserType,
    useUser: (options?: { id?: number }) =>
      options?.id
        ? {
            user: { id: 9, userType: user.UserType.LOCAL, warnings: [] },
            hasPermission: () => false,
            revalidate: vi.fn(),
          }
        : {
            user: { id: 1, userType: user.UserType.LOCAL, warnings: [] },
            hasPermission: (permission: number) =>
              permission === permissions.Permission.MANAGE_USERS,
          },
  };
});
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: {
      locale: 'en',
      originalLanguage: '',
      mediaServerType: MediaServerType.PLEX,
    },
  }),
}));
vi.mock('@app/hooks/useLocale', () => ({
  default: () => ({ locale: 'en', setLocale: vi.fn() }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/LanguageSelector', () => ({ default: () => null }));
vi.mock('@app/components/RegionSelector', () => ({ default: () => null }));
vi.mock(
  '@app/components/UserProfile/UserSettings/UserGeneralSettings/RequestRootFolderSettings',
  () => ({ default: () => null })
);
vi.mock('@app/pages/_error', () => ({ default: () => null }));

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.data = {
    username: 'Sample Reader',
    email: 'reader@example.com',
    locale: '',
    globalMangaQuotaLimit: 3,
    globalMangaQuotaDays: 7,
  };
  state.post.mockReset().mockResolvedValue({ status: 200 });
  state.revalidate.mockReset();
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
        <UserGeneralSettings />
      </IntlProvider>
    )
  );
};

const mangaRow = () => {
  const label = [...host.querySelectorAll('.text-label span')].find(
    (element) => element.textContent === 'Manga Request Limit'
  );
  expect(label).toBeTruthy();
  const row = label!.closest('.form-row')!;
  return {
    override: row.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    selects: [...row.querySelectorAll('select')] as HTMLSelectElement[],
  };
};

const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};

const submit = async () => {
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
      );
  });
};

it('shows the global manga limit until a manager overrides it', async () => {
  await render();
  const { override, selects } = mangaRow();

  expect(override.checked).toBe(false);
  expect(selects.map((select) => select.disabled)).toEqual([true, true]);
  expect(selects.map((select) => select.value)).toEqual(['3', '7']);
});

it('saves a per-user manga request limit', async () => {
  await render();
  await act(async () => {
    mangaRow().override.click();
  });
  const [limit, days] = mangaRow().selects;
  await choose(limit, '6');
  await choose(days, '30');
  await submit();

  expect(state.post).toHaveBeenCalledTimes(1);
  const [url, body] = state.post.mock.calls[0];
  expect(url).toBe('/api/v1/user/9/settings/main');
  expect(body).toMatchObject({ mangaQuotaLimit: 6, mangaQuotaDays: 30 });
});

it('clears the per-user manga limit when the override is turned off', async () => {
  state.data = { ...state.data, mangaQuotaLimit: 2, mangaQuotaDays: 5 };
  await render();
  expect(mangaRow().override.checked).toBe(true);
  expect(mangaRow().selects.map((select) => select.value)).toEqual(['2', '5']);

  await act(async () => {
    mangaRow().override.click();
  });
  await submit();

  expect(state.post.mock.calls[0][1]).toMatchObject({
    mangaQuotaLimit: null,
    mangaQuotaDays: null,
  });
});
