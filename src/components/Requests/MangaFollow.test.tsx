import {
  MANGA_FOLLOW_PAUSE_REASONS,
  MangaFollowStopReason,
} from '@server/constants/mangaFollow';
import { MediaRequestStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MangaFollowControl,
  MangaFollowField,
  MangaFollowRequestSettings,
  MangaFollowStatusLine,
  type MangaFollowRequest,
} from './MangaFollow';

const OWNER_ID = 7;
const MANAGER_ID = 1;

const state = vi.hoisted(() => ({
  put: vi.fn(),
  addToast: vi.fn(),
  user: undefined as { id: number; permissions: number } | undefined,
}));
vi.mock('axios', () => ({ default: { put: state.put } }));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/hooks/useUser', () => ({
  useUser: () => ({ user: state.user }),
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content: string;
  }) => <span title={content}>{children}</span>,
}));
// The shared listbox is a Headless UI control; this stand-in exposes the
// props the follow control chooses and one button per offered option.
vi.mock('@app/components/RequestModal/AdvancedRequester', () => ({
  RequestListboxControl: ({
    id,
    label,
    value,
    options,
    onChange,
    disabled,
    loadingLabel,
  }: {
    id: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
    loadingLabel: string;
  }) => (
    <div
      data-testid="listbox"
      id={id}
      data-label={label}
      data-value={value}
      data-disabled={String(Boolean(disabled))}
      data-loading-label={loadingLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-option={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

type FollowRequest = MangaFollowRequest & {
  mangaScope?: {
    follow: {
      enabled: boolean;
      stopReason: MangaFollowStopReason | null;
      lastCheckAt: string | null;
      nextCheckAt: string | null;
    };
  };
};

const mangaRequest = ({
  enabled = false,
  stopReason = null,
  ...values
}: Partial<MangaFollowRequest> & {
  enabled?: boolean;
  stopReason?: MangaFollowStopReason | null;
} = {}): FollowRequest => ({
  id: 41,
  type: 'manga',
  status: MediaRequestStatus.APPROVED,
  requestedBy: { id: OWNER_ID },
  mangaScope: {
    follow: {
      enabled,
      stopReason,
      lastCheckAt: '2026-01-01T00:00:00.000Z',
      nextCheckAt: null,
    },
  },
  ...values,
});

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;
const onUpdated = vi.fn();

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.put.mockReset();
  state.put.mockResolvedValue({ data: {} });
  state.addToast.mockReset();
  onUpdated.mockReset();
  onUpdated.mockResolvedValue(undefined);
  state.user = { id: OWNER_ID, permissions: Permission.REQUEST };
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const renderControl = async (request: FollowRequest) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <MangaFollowControl request={request} onUpdated={onUpdated} />
      </IntlProvider>
    )
  );
};

const listbox = () =>
  host.querySelector<HTMLElement>('[data-testid="listbox"]');
const offered = () =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-option]')].map(
    (button) => button.dataset.option
  );
const choose = async (value: 'on' | 'off') => {
  const button = host.querySelector<HTMLButtonElement>(
    `[data-option="${value}"]`
  );
  expect(button).not.toBeNull();
  await act(async () => button?.click());
};

describe('MangaFollowControl', () => {
  it('lets the owner turn following on', async () => {
    await renderControl(mangaRequest());

    expect(listbox()?.id).toBe('manga-follow-41');
    expect(listbox()?.dataset.label).toBe('Follow New Chapters');
    expect(listbox()?.dataset.value).toBe('off');
    expect(offered()).toEqual(['off', 'on']);
    expect(host.querySelector('[title]')?.getAttribute('title')).toContain(
      'Only the requester can turn it on'
    );

    await choose('on');

    expect(state.put).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/request/41/follow',
      { enabled: true }
    );
    expect(onUpdated).toHaveBeenCalledOnce();
    expect(state.addToast).toHaveBeenCalledWith(
      'Following new chapters updated.',
      { appearance: 'success', autoDismiss: true }
    );
    expect(listbox()?.dataset.value).toBe('on');
  });

  it('lets the owner turn following off', async () => {
    await renderControl(mangaRequest({ enabled: true }));

    expect(listbox()?.dataset.value).toBe('on');
    expect(offered()).toEqual(['off', 'on']);

    await choose('off');

    expect(state.put).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/request/41/follow',
      { enabled: false }
    );
    expect(listbox()?.dataset.value).toBe('off');
  });

  it('sends nothing when the current choice is picked again', async () => {
    await renderControl(mangaRequest({ enabled: true }));

    await choose('on');

    expect(state.put).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('keeps the choice and reports a failed update', async () => {
    state.put.mockRejectedValue(new Error('409'));
    await renderControl(mangaRequest());

    await choose('on');

    expect(state.addToast).toHaveBeenCalledWith(
      'Unable to update following new chapters.',
      { appearance: 'error', autoDismiss: true }
    );
    expect(onUpdated).not.toHaveBeenCalled();
    expect(listbox()?.dataset.value).toBe('off');
    expect(listbox()?.dataset.disabled).toBe('false');
  });

  it('shows an administrator only the option to turn following off', async () => {
    state.user = { id: MANAGER_ID, permissions: Permission.MANAGE_REQUESTS };
    await renderControl(mangaRequest({ enabled: true }));

    expect(offered()).toEqual(['off']);
    expect(listbox()?.dataset.value).toBe('on');
    expect(listbox()?.dataset.loadingLabel).toBe('On');

    await choose('off');

    expect(state.put).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/request/41/follow',
      { enabled: false }
    );
    expect(listbox()).toBeNull();
  });

  it('gives an administrator no control while following is off', async () => {
    state.user = { id: MANAGER_ID, permissions: Permission.ADMIN };
    await renderControl(mangaRequest());

    expect(listbox()).toBeNull();
  });

  it('offers only turning off once the request can no longer follow', async () => {
    await renderControl(
      mangaRequest({ enabled: true, status: MediaRequestStatus.DECLINED })
    );
    expect(offered()).toEqual(['off']);

    await renderControl(mangaRequest({ status: MediaRequestStatus.DECLINED }));
    expect(listbox()).toBeNull();
  });

  it('renders nothing for other requests', async () => {
    await renderControl(mangaRequest({ type: 'book' }));
    expect(listbox()).toBeNull();

    await renderControl({ ...mangaRequest(), mangaScope: undefined });
    expect(listbox()).toBeNull();
  });
});

const STATUS_LINES: Record<MangaFollowStopReason, string> = {
  [MangaFollowStopReason.OWNER_NOT_PERMITTED]:
    'Following new chapters stopped because the requester can no longer request manga.',
  [MangaFollowStopReason.REQUEST_DECLINED]:
    'Following new chapters stopped because this request was declined.',
  [MangaFollowStopReason.REQUEST_FAILED]:
    'Following new chapters stopped because this request failed.',
  [MangaFollowStopReason.RANGE_COMPLETE]:
    'Following new chapters stopped because this request already includes the last chapter of its range.',
  [MangaFollowStopReason.MANIFEST_LIMIT]:
    'Following new chapters stopped because this request reached the limit of 10,000 chapters.',
  [MangaFollowStopReason.BINDING_INACTIVE]:
    'Following new chapters is paused because this title has no active match on the connected manga service. SeerrNG checks again every day; an administrator can review the match under Settings → Manga Library.',
  [MangaFollowStopReason.INSTANCE_MISSING]:
    'Following new chapters is paused because the manga service this request was made for is no longer configured, or its settings are incomplete. SeerrNG checks again every day; an administrator can check it under Settings → Services.',
  [MangaFollowStopReason.BINDING_CHANGED]:
    'Following new chapters is paused because this title is now matched to a different manga on the connected manga service. SeerrNG checks again every day; an administrator can review the match under Settings → Manga Library.',
  [MangaFollowStopReason.MANGA_NOT_FOUND]:
    'Following new chapters is paused because the connected manga service no longer has the manga this request was sent to. SeerrNG checks again every day; an administrator can review the match under Settings → Manga Library.',
};

const renderStatusLine = async (request: FollowRequest) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <MangaFollowStatusLine request={request} />
      </IntlProvider>
    )
  );
};

describe('MangaFollowStatusLine', () => {
  for (const [reason, text] of Object.entries(STATUS_LINES)) {
    it(`explains ${reason}`, async () => {
      await renderStatusLine(
        mangaRequest({
          stopReason: reason as MangaFollowStopReason,
          // Pauses keep following on; stops turn it off.
          enabled: MANGA_FOLLOW_PAUSE_REASONS.has(reason),
        })
      );

      const line = host.querySelector('p');
      expect(line?.className).toBe('request-status-note refreshed-detail-text');
      expect(line?.textContent).toBe(text);
    });
  }

  it('shows nothing while following runs or for other requests', async () => {
    await renderStatusLine(mangaRequest({ enabled: true }));
    expect(host.querySelector('p')).toBeNull();

    await renderStatusLine(
      mangaRequest({
        type: 'book',
        stopReason: MangaFollowStopReason.REQUEST_DECLINED,
      })
    );
    expect(host.querySelector('p')).toBeNull();
  });
});

const INSET_CARD =
  'app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3';

describe('MangaFollowField', () => {
  it('offers Off and On in a standard inset card and reports the choice', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <IntlProvider locale="en" timeZone="UTC">
          <MangaFollowField
            enabled={false}
            disabled={false}
            onChange={onChange}
          />
        </IntlProvider>
      )
    );

    expect(listbox()?.dataset.label).toBe('Follow New Chapters');
    expect(listbox()?.dataset.value).toBe('off');
    expect(offered()).toEqual(['off', 'on']);
    expect(listbox()?.parentElement?.className).toBe(INSET_CARD);
    const help = host.querySelector('p');
    expect(help?.className).toBe('refreshed-detail-text-muted mt-2 text-xs');
    expect(help?.textContent).toContain('Only the requester can turn it on');

    await choose('on');
    await choose('off');

    expect(onChange.mock.calls).toEqual([[true], [false]]);
    expect(state.put).not.toHaveBeenCalled();
  });
});

const renderSettings = async (request: FollowRequest) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <MangaFollowRequestSettings request={request} onUpdated={onUpdated} />
      </IntlProvider>
    )
  );
};

describe('MangaFollowRequestSettings', () => {
  it('gives the owner the control in a card, then the status line', async () => {
    await renderSettings(
      mangaRequest({
        enabled: true,
        stopReason: MangaFollowStopReason.BINDING_INACTIVE,
      })
    );

    expect(listbox()?.id).toBe('manga-follow-request-41');
    expect(offered()).toEqual(['off', 'on']);
    const card = listbox()?.parentElement;
    expect(card?.className).toBe(INSET_CARD);
    const note = host.querySelector('p.request-status-note');
    expect(note?.textContent).toBe(
      STATUS_LINES[MangaFollowStopReason.BINDING_INACTIVE]
    );
    expect(card?.contains(note ?? null)).toBe(false);

    await choose('off');

    expect(state.put).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/request/41/follow',
      { enabled: false }
    );
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('shows a viewer without the control only the status line', async () => {
    state.user = { id: MANAGER_ID, permissions: Permission.REQUEST };
    await renderSettings(
      mangaRequest({
        status: MediaRequestStatus.DECLINED,
        stopReason: MangaFollowStopReason.REQUEST_DECLINED,
      })
    );

    expect(listbox()).toBeNull();
    expect(host.querySelector('p.request-status-note')?.textContent).toBe(
      STATUS_LINES[MangaFollowStopReason.REQUEST_DECLINED]
    );
  });

  it('treats a request without its requester as another user’s', async () => {
    await renderSettings({ ...mangaRequest(), requestedBy: undefined });
    expect(listbox()).toBeNull();

    state.user = { id: MANAGER_ID, permissions: Permission.MANAGE_REQUESTS };
    await renderSettings({
      ...mangaRequest({ enabled: true }),
      requestedBy: undefined,
    });
    expect(offered()).toEqual(['off']);
  });
});
