import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsCategories from '.';

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
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
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
    enabledMediaCategories: { movie: true, tv: true },
    mangaIncludeAdult: false,
    mangaIncludeNovels: false,
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
        <SettingsCategories />
      </IntlProvider>
    )
  );
};

const toggle = (testId: string) =>
  host.querySelector(`[data-testid="${testId}"]`);

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
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

it('lists manga as a category that is off by default', async () => {
  await render();

  expect(host.textContent).toContain('Manga');
  expect(toggle('category-toggle-manga')?.getAttribute('aria-pressed')).toBe(
    'false'
  );
  expect(toggle('category-toggle-movie')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
  expect(
    toggle('manga-content-toggle-mangaIncludeAdult')?.getAttribute(
      'aria-pressed'
    )
  ).toBe('false');
  expect(
    toggle('manga-content-toggle-mangaIncludeNovels')?.getAttribute(
      'aria-pressed'
    )
  ).toBe('false');
});

it('saves the manga category with the adult and novel toggles', async () => {
  await render();
  await click(toggle('category-toggle-manga'));
  await click(toggle('manga-content-toggle-mangaIncludeNovels'));
  await submit();

  expect(state.post).toHaveBeenCalledTimes(1);
  const [url, body] = state.post.mock.calls[0];
  expect(url).toBe('/api/v1/settings/main');
  expect(body).toMatchObject({
    enabledMediaCategories: { manga: true, movie: true },
    mangaIncludeAdult: false,
    mangaIncludeNovels: true,
  });
  expect(state.mutate).toHaveBeenCalledWith('/api/v1/settings/public');
});

it('shows the saved manga settings', async () => {
  state.data = {
    enabledMediaCategories: { manga: true },
    mangaIncludeAdult: true,
    mangaIncludeNovels: false,
  };
  await render();

  expect(toggle('category-toggle-manga')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
  expect(
    toggle('manga-content-toggle-mangaIncludeAdult')?.getAttribute(
      'aria-pressed'
    )
  ).toBe('true');
});
