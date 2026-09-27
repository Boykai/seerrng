import { MediaType } from '@server/constants/media';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useTitleBlocklist, {
  fetchTitleBlocklist,
  getTitleBlocklistKey,
} from './useTitleBlocklist';

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({
  default: {
    get: state.get,
    isAxiosError: (e: unknown) =>
      typeof e === 'object' && e !== null && 'response' in e,
  },
}));
vi.mock('@app/hooks/useUser', () => ({
  Permission: { MANAGE_BLOCKLIST: 1 },
  useUser: () => ({ hasPermission: () => true }),
}));
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
  state.get.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

it('uses media-type scoped normalized membership keys', () => {
  expect(getTitleBlocklistKey(123, MediaType.MOVIE)).toBe(
    'title-blocklist:/api/v1/blocklist/123?mediaType=movie'
  );
  expect(getTitleBlocklistKey(123, MediaType.TV)).toBe(
    'title-blocklist:/api/v1/blocklist/123?mediaType=tv'
  );
  expect(getTitleBlocklistKey('/works/ol123w', MediaType.BOOK)).toBe(
    'title-blocklist:/api/v1/blocklist/OL123W?mediaType=book'
  );
  expect(
    getTitleBlocklistKey(
      ' AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE ',
      MediaType.MUSIC
    )
  ).toBe(
    'title-blocklist:/api/v1/blocklist/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?mediaType=music'
  );
  for (const id of [null, undefined, '', 0, -1, 'bad'])
    expect(getTitleBlocklistKey(id, MediaType.MOVIE)).toBeNull();
});
it('treats only a missing membership as unblocked and preserves other failures', async () => {
  state.get.mockResolvedValueOnce({ data: { id: 24 } });
  expect(await fetchTitleBlocklist('title-blocklist:/test')).toBe(true);
  expect(state.get).toHaveBeenLastCalledWith('/test');
  state.get.mockRejectedValueOnce({ response: { status: 404 } });
  expect(await fetchTitleBlocklist('/test')).toBe(false);
  for (const status of [403, 500]) {
    const failure = { response: { status } };
    state.get.mockRejectedValueOnce(failure);
    await expect(fetchTitleBlocklist('/test')).rejects.toEqual(failure);
  }
});

it('shares confirmed detail-page writes with already mounted Manage and newly opened Manage', async () => {
  const key = getTitleBlocklistKey(123, MediaType.MOVIE)!;
  const cache = new Map();
  const config = {
    provider: () => cache,
    fallback: { [key]: false },
    revalidateOnMount: false,
  };
  const Consumer = ({ name }: { name: string }) => {
    const { isBlocklisted, setBlocklisted } = useTitleBlocklist(
      123,
      MediaType.MOVIE,
      false
    );
    return (
      <button
        data-name={name}
        onClick={() => void setBlocklisted(!isBlocklisted)}
      >
        {String(isBlocklisted)}
      </button>
    );
  };
  const View = ({ open }: { open: boolean }) => (
    <SWRConfig value={config}>
      <Consumer name="details" />
      {open && <Consumer name="manage" />}
    </SWRConfig>
  );
  await act(async () => root.render(<View open />));
  const value = (name: string) =>
    host.querySelector(`[data-name="${name}"]`)?.textContent;
  const click = async (name: string) => {
    await act(async () =>
      (host.querySelector(`[data-name="${name}"]`) as HTMLButtonElement).click()
    );
  };
  expect(value('manage')).toBe('false');
  await click('details');
  expect(value('manage')).toBe('true');
  await click('manage');
  expect(value('details')).toBe('false');
  await act(async () => root.render(<View open={false} />));
  await click('details');
  await act(async () => root.render(<View open />));
  expect(value('manage')).toBe('true');
});
