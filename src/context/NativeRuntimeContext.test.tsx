import { MediaServerType } from '@server/constants/server';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NativeRuntimeProvider,
  useNativeRuntime,
} from './NativeRuntimeContext';
import { nativeRuntimeProtocolV1 } from './nativeRuntimeProtocol';

const state = vi.hoisted(() => ({
  post: vi.fn(),
  commands: [] as {
    id: string;
    type: string;
    ticket?: string;
    itemId?: string;
  }[],
  user: {
    id: 7,
    jellyfinUsername: 'linked-user',
    updatedAt: '2026-09-29T00:00:00.000Z',
  },
  mediaServerType: 2,
}));

vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { mediaServerType: state.mediaServerType },
  }),
}));

vi.mock('@app/hooks/useUser', () => ({
  useUser: () => ({ user: state.user, loading: false, error: undefined }),
}));

vi.mock('axios', () => ({
  default: {
    post: state.post,
    isAxiosError: () => false,
  },
}));

describe('NativeRuntimeProvider recovery handling', () => {
  let dom: JSDOM;
  let root: Root;
  let mount: HTMLDivElement;
  let nextRequestId: number;

  const emit = async (type: string, id: string, extra = {}) => {
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.CustomEvent(nativeRuntimeProtocolV1.eventName, {
          detail: {
            protocolVersion: nativeRuntimeProtocolV1.protocolVersion,
            type,
            id,
            ...extra,
          },
        })
      );
      await Promise.resolve();
    });
  };

  const renderProvider = async (onPlay: (accepted: boolean) => void) => {
    const Consumer = () => {
      const { playItem } = useNativeRuntime();
      return (
        <button onClick={() => onPlay(playItem('jellyfin-item'))}>Play</button>
      );
    };

    await act(async () => {
      root.render(
        <NativeRuntimeProvider>
          <Consumer />
        </NativeRuntimeProvider>
      );
    });
  };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://seerr.test',
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(dom.window.crypto, 'randomUUID', {
      configurable: true,
      value: () => `request-${++nextRequestId}`,
    });

    mount = document.createElement('div');
    document.body.append(mount);
    root = createRoot(mount);
    nextRequestId = 0;
    state.commands = [];
    state.user = {
      id: 7,
      jellyfinUsername: 'linked-user',
      updatedAt: '2026-09-29T00:00:00.000Z',
    };
    state.mediaServerType = MediaServerType.JELLYFIN;
    state.post.mockReset().mockResolvedValue({
      data: { ticket: 'a'.repeat(43), expiresIn: 60 },
    });

    dom.window.foreseerNative = {
      protocolVersion: 1,
      hostName: 'foreseer-desktop',
      hostVersion: '0.3.0',
      capabilities: [...nativeRuntimeProtocolV1.requiredCapabilities],
      send: (command) => {
        state.commands.push(command);
        return true;
      },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('ignores duplicate recovery notices while bootstrap or an authenticated session is active', async () => {
    let playAccepted = false;
    await renderProvider((accepted) => {
      playAccepted = accepted;
    });

    const challengeId = state.commands.find(
      (command) => command.type === 'auth.challenge'
    )?.id;
    expect(challengeId).toBeDefined();
    expect(
      state.commands.filter((command) => command.type === 'session.clear')
    ).toHaveLength(1);

    await emit('runtime-recovered', 'recovery-during-bootstrap');
    expect(
      state.commands.filter((command) => command.type === 'auth.challenge')
    ).toHaveLength(1);
    expect(
      state.commands.filter((command) => command.type === 'session.clear')
    ).toHaveLength(1);

    await emit('auth-challenge', challengeId!, {
      challenge: 'a'.repeat(64),
    });
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(
      state.commands.filter((command) => command.type === 'auth.complete')
    ).toHaveLength(1);

    await emit('ready', challengeId!);
    await emit('runtime-recovered', 'duplicate-recovery');
    expect(
      state.commands.filter((command) => command.type === 'auth.challenge')
    ).toHaveLength(1);
    expect(
      state.commands.filter((command) => command.type === 'session.clear')
    ).toHaveLength(1);

    await act(async () => {
      mount.querySelector('button')?.click();
    });
    expect(playAccepted).toBe(true);
    expect(
      state.commands.filter((command) => command.type === 'play.item')
    ).toHaveLength(1);
  });

  it('restarts authentication after the runtime reports a failure and recovery', async () => {
    await renderProvider(() => undefined);

    await emit('runtime-failed', 'runtime-failure');
    await emit('runtime-recovered', 'runtime-recovery');

    expect(
      state.commands.filter((command) => command.type === 'session.clear')
    ).toHaveLength(2);
    expect(
      state.commands.filter((command) => command.type === 'auth.challenge')
    ).toHaveLength(2);
  });
});
