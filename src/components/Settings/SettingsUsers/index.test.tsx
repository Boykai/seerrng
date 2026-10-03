import { MediaServerType } from '@server/constants/server';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsUsers from '.';

const quota = (quotaLimit: number, quotaDays: number) => ({
  quotaLimit,
  quotaDays,
});

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  post: vi.fn(),
  revalidate: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('swr', () => ({
  default: () => ({ data: state.data, mutate: state.revalidate }),
  mutate: state.mutate,
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/PermissionEdit', () => ({ default: () => null }));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { mediaServerType: MediaServerType.PLEX },
  }),
}));

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
    localLogin: true,
    mediaServerLogin: true,
    newPlexLogin: true,
    defaultPermissions: 32,
    defaultQuotas: {
      movie: quota(0, 7),
      tv: quota(0, 7),
      music: quota(0, 7),
      book: quota(0, 7),
      comic: quota(4, 7),
      magazine: quota(0, 7),
      manga: quota(2, 7),
      software: quota(0, 7),
    },
  };
  state.post.mockReset().mockResolvedValue({ status: 200 });
  state.revalidate.mockReset();
  state.mutate.mockReset();
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
        <SettingsUsers />
      </IntlProvider>
    )
  );
};

const mangaSelects = () => {
  const label = [...host.querySelectorAll('label')].find(
    (element) => element.textContent === 'Global Manga Request Limit'
  );
  expect(label).toBeTruthy();
  return [
    ...label!.closest('.form-row')!.querySelectorAll('select'),
  ] as HTMLSelectElement[];
};

const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};

it('shows the global manga request limit from the saved defaults', async () => {
  await render();

  const [limit, days] = mangaSelects();
  expect(limit.value).toBe('2');
  expect(days.value).toBe('7');
});

it('saves the global manga request limit with the other defaults', async () => {
  await render();
  const [limit, days] = mangaSelects();
  await choose(limit, '5');
  await choose(days, '14');
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
      );
  });

  expect(state.post).toHaveBeenCalledTimes(1);
  const [url, body] = state.post.mock.calls[0];
  expect(url).toBe('/api/v1/settings/main');
  expect(body.defaultQuotas.manga).toEqual({ quotaLimit: 5, quotaDays: 14 });
  expect(body.defaultQuotas.comic).toEqual({ quotaLimit: 4, quotaDays: 7 });
});
