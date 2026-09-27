import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, expect, it, vi } from 'vitest';
import DiscographyRequestActions from './DiscographyRequestActions';

const state = vi.hoisted(() => ({
  allowed: true,
  services: [
    { id: 7, name: 'Lidarr-MP3' },
    { id: 9, name: 'Lidarr-FLAC' },
  ],
  post: vi.fn(),
  replace: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock('swr', () => ({
  default: () => ({ data: state.services }),
  mutate: state.mutate,
}));
vi.mock('@app/hooks/useUser', () => ({
  Permission: { REQUEST: 1, REQUEST_MUSIC: 2 },
  useUser: () => ({ hasPermission: () => state.allowed }),
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.allowed = true;
});

it('confirms only the current selection, sends format-specific batches, and cancels to the source album', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')!);
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: String(index),
    title: String(index),
    releaseDate: '2000',
    genres: [],
  }));
  const render = async (selected = items) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en">
          <DiscographyRequestActions
            items={selected}
            returnHref="/music/source-album"
          />
        </IntlProvider>
      )
    );
  const click = async (label: string) =>
    act(async () => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === label)!
        .click();
    });
  state.post.mockResolvedValue({
    data: { created: [], skipped: [], failed: [] },
  });
  try {
    await render();
    expect(
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Cancel')
        ?.classList.contains('app-button-danger')
    ).toBe(true);
    await click('MP3');
    expect(state.post).not.toHaveBeenCalled();
    await render(items.slice(0, 1));
    expect(document.body.textContent).not.toContain('Request 51 selected');
    await render();
    await click('FLAC');
    await click('Request 51 selected albums as FLAC?');
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(state.post.mock.calls[0][1]).toMatchObject({
      mediaType: 'music',
      serverId: 9,
    });
    expect(state.post.mock.calls[0][1].items).toHaveLength(50);
    expect(state.post.mock.calls[1][1].items).toHaveLength(1);
    await render(items.slice(0, 1));
    state.post.mockRejectedValueOnce(new Error('network'));
    await click('MP3');
    await click('Request 1 selected album as MP3?');
    expect(state.post.mock.calls[2][1].serverId).toBe(7);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Check request history before retrying'
    );
    await render([]);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="format-request-option-mp3"]'
      )?.disabled
    ).toBe(true);
    await click('Cancel');
    expect(state.replace).toHaveBeenCalledWith('/music/source-album');
    state.allowed = false;
    await render();
    expect(
      document.querySelector('[data-testid="format-request-control"]')
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
