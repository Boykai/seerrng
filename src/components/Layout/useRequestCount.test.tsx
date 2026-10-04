import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useRequestCount from './useRequestCount';

let dom: JSDOM;
let root: Root;
let host: HTMLDivElement;
let pendingCount: number;
let fetchCount: number;

const PendingCount = () => {
  const { data } = useRequestCount(true);
  return <output>{data?.pending ?? 'loading'}</output>;
};

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Event', dom.window.Event);
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
  vi.useFakeTimers();
  pendingCount = 29;
  fetchCount = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('request count freshness', () => {
  it('refreshes pending counts while the app remains open', async () => {
    await act(async () =>
      root.render(
        <SWRConfig
          value={{
            provider: () => new Map(),
            fetcher: async () => {
              fetchCount += 1;
              return { pending: pendingCount };
            },
          }}
        >
          <PendingCount />
        </SWRConfig>
      )
    );
    expect(host.querySelector('output')?.textContent).toBe('29');
    expect(fetchCount).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    pendingCount = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(fetchCount).toBe(2);
    expect(host.querySelector('output')?.textContent).toBe('0');
  });
});
