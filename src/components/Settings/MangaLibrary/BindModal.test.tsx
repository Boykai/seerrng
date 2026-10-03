import BindModal, {
  mangaSearchKey,
} from '@app/components/Settings/MangaLibrary/BindModal';
import type * as HeadlessUi from '@headlessui/react';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React DOM checks for the input event when it loads, so a DOM must exist
// before React is imported for typed text to reach the change handlers.
await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
});

const state = vi.hoisted(() => ({
  responses: new Map<string, { data?: unknown; error?: unknown }>(),
  keys: [] as unknown[],
  onBind: vi.fn(),
  onCancel: vi.fn(),
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
    const response = key ? state.responses.get(key) : undefined;
    return { data: response?.data, error: response?.error };
  },
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/hooks/useDebouncedState', async () => {
  const { useState } = await import('react');
  return {
    default: function useDebouncedState(initial: string) {
      const [value, setValue] = useState(initial);
      return [value, value, setValue];
    },
  };
});
vi.mock('@headlessui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof HeadlessUi>()),
  Transition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/components/Common/Modal', () => ({
  default: (props: {
    title: string;
    subTitle?: string;
    children: React.ReactNode;
    okText: string;
    okDisabled: boolean;
    onOk: () => void;
    onCancel: () => void;
  }) => (
    <div>
      <h2>{props.title}</h2>
      <h3 data-testid="modal-subtitle">{props.subTitle}</h3>
      {props.children}
      <button
        type="button"
        data-testid="modal-ok-button"
        disabled={props.okDisabled}
        onClick={props.onOk}
      >
        {props.okText}
      </button>
      <button
        type="button"
        data-testid="modal-cancel-button"
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </div>
  ),
}));

const results = (...ids: number[]) => ({
  data: {
    results: ids.map((id) => ({
      id,
      mediaType: 'manga',
      title: `Catalog Title ${id}`,
      startYear: 2000 + id,
    })),
  },
});

let dom: JSDOM;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of [
    'window',
    'document',
    'Element',
    'Node',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'MutationObserver',
    'Event',
  ]) {
    vi.stubGlobal(
      key,
      key === 'window' ? dom.window : dom.window[key as keyof Window]
    );
  }
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.responses.clear();
  state.keys.length = 0;
  state.onBind.mockReset();
  state.onCancel.mockReset();
  state.responses.set('/api/v1/discover/manga?query=sample', results(7, 8));
  state.responses.set('/api/v1/discover/manga?query=other', results(9));
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const render = async (busy = false) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <BindModal
          libraryTitle="Sample Manga A"
          busy={busy}
          onBind={state.onBind}
          onCancel={state.onCancel}
        />
      </IntlProvider>
    )
  );
  await flush();
};

const ok = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="modal-ok-button"]')!;
const pick = (title: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`);

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  await flush();
};

const search = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('#mangaLibrarySearch')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush();
};

describe('mangaSearchKey', () => {
  it('searches the AniList catalog with the trimmed query', () => {
    expect(mangaSearchKey('')).toBeNull();
    expect(mangaSearchKey('   ')).toBeNull();
    expect(mangaSearchKey(' Sample Title ')).toBe(
      '/api/v1/discover/manga?query=Sample%20Title'
    );
    expect(mangaSearchKey('a&id=1')).toBe(
      '/api/v1/discover/manga?query=a%26id%3D1'
    );
  });
});

describe('BindModal', () => {
  it('waits for a search and shows the library title as text', async () => {
    await render();

    expect(state.keys.filter(Boolean)).toEqual([]);
    expect(
      host.querySelector('[data-testid="modal-subtitle"]')?.textContent
    ).toBe('Sample Manga A');
    expect(host.querySelector('a')).toBeNull();
    expect(ok().disabled).toBe(true);
    expect(ok().textContent).toBe('Confirm');
    // AniList IDs come from search results only.
    expect(host.querySelectorAll('input')).toHaveLength(1);
    expect(
      host.querySelector<HTMLInputElement>('#mangaLibrarySearch')?.type
    ).toBe('text');
  });

  it('binds the title picked from the search results', async () => {
    await render();
    await search('sample');

    expect(state.keys).toContain('/api/v1/discover/manga?query=sample');
    expect(host.textContent).toContain('Catalog Title 7');
    expect(host.textContent).toContain('2008');
    expect(ok().disabled).toBe(true);

    await click(pick('Catalog Title 8'));
    expect(pick('Catalog Title 8')?.getAttribute('aria-pressed')).toBe('true');
    expect(pick('Catalog Title 7')?.getAttribute('aria-pressed')).toBe('false');
    expect(ok().disabled).toBe(false);

    await click(ok());
    expect(state.onBind).toHaveBeenCalledWith(8);
  });

  it('drops the pick when it is clicked again or the search changes', async () => {
    await render();
    await search('sample');

    await click(pick('Catalog Title 7'));
    await click(pick('Catalog Title 7'));
    expect(ok().disabled).toBe(true);

    await click(pick('Catalog Title 7'));
    expect(ok().disabled).toBe(false);
    await search('other');

    expect(host.textContent).not.toContain('Catalog Title 7');
    expect(pick('Catalog Title 9')?.getAttribute('aria-pressed')).toBe('false');
    expect(ok().disabled).toBe(true);
    await click(ok());
    expect(state.onBind).not.toHaveBeenCalled();
  });

  it('locks the pick while the bind is saving', async () => {
    await render(true);
    await search('sample');

    expect(ok().textContent).toBe('Saving…');
    expect(ok().disabled).toBe(true);
    expect(pick('Catalog Title 7')?.disabled).toBe(true);
  });

  it('says when the search is loading, failed or found nothing', async () => {
    await render();

    await search('loading');
    expect(host.textContent).toContain('Loading…');

    state.responses.set('/api/v1/discover/manga?query=broken', {
      error: new Error('raw upstream text'),
    });
    await search('broken');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Something went wrong. Please try again.'
    );
    expect(host.textContent).not.toContain('raw upstream text');

    state.responses.set('/api/v1/discover/manga?query=none', results());
    await search('none');
    expect(host.textContent).toContain('No results');
  });

  it('closes on cancel', async () => {
    await render();

    await click(host.querySelector('[data-testid="modal-cancel-button"]'));

    expect(state.onCancel).toHaveBeenCalledTimes(1);
    expect(state.onBind).not.toHaveBeenCalled();
  });
});
