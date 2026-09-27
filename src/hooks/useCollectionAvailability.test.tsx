import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useCollectionAvailability from './useCollectionAvailability';
const mock = vi.hoisted(() => ({
  refresh: vi.fn().mockResolvedValue(undefined),
  keys: [] as unknown[],
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { mediaServerType: 1, movie4kEnabled: true },
  }),
}));
vi.mock('@app/hooks/useUser', () => ({
  useUser: () => ({ user: { id: 1 }, hasPermission: () => true }),
  Permission: { ADMIN: 2 },
}));
vi.mock('swr', () => ({
  default: (key: unknown) => {
    mock.keys.push(key);
    return {
      mutate: mock.refresh,
      isValidating: false,
      error: new Error('offline response'),
    };
  },
  useSWRConfig: () => ({ mutate: mock.refresh }),
}));
function Probe() {
  useCollectionAvailability('55');
  return null;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mock.refresh.mockClear();
  mock.keys.length = 0;
});
describe('collection page polling', () => {
  it('retries each minute while visible, pauses hidden/offline, and stops on unmount', async () => {
    const dom = new JSDOM('<html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('Event', dom.window.Event);
    vi.useFakeTimers();
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    expect(mock.keys.at(-1)).toEqual([
      'collection-availability',
      1,
      'movie',
      '55',
    ]);
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mock.keys.at(-1)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(120000);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });
      window.dispatchEvent(new Event('offline'));
    });
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    await act(async () => {
      vi.advanceTimersByTime(120000);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(2);
    dom.window.close();
  });
});
