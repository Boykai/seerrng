import {
  isForeseerNativeEventV1,
  isUsableForeseerNative,
  nativeRuntimeProtocolV1,
} from '@app/context/nativeRuntimeProtocol';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type NativeRuntimeState =
  'web' | 'probing' | 'authenticating' | 'ready' | 'playing' | 'degraded';

interface NativeRuntimeContextValue {
  playItem: (itemId: string) => boolean;
  clearSession: () => void;
}

interface AuthTicketResponse {
  ticket: string;
  expiresIn: number;
}

const NativeRuntimeContext = createContext<NativeRuntimeContextValue>({
  playItem: () => false,
  clearSession: () => undefined,
});

const createRequestId = (): string => window.crypto.randomUUID();

const sendNativeCommand = (
  host: NonNullable<Window['foreseerNative']>,
  command: Parameters<typeof host.send>[0]
): boolean => {
  try {
    return host.send(command);
  } catch {
    return false;
  }
};

export const NativeRuntimeProvider = ({
  children,
}: React.PropsWithChildren) => {
  const [state, setState] = useState<NativeRuntimeState>('web');
  const [sessionResetRetry, setSessionResetRetry] = useState(0);
  const activePlayRequestId = useRef<string | undefined>(undefined);
  const activePlayTimeout = useRef<number | undefined>(undefined);
  const previousUserId = useRef<number | undefined>(undefined);
  const previousJellyfinUsername = useRef<string | null | undefined>(undefined);
  const previousUserUpdatedAt = useRef<string>('');
  const previousMediaServerType = useRef<MediaServerType | undefined>(
    undefined
  );
  const hasObservedUserState = useRef(false);
  const { user, loading, error } = useUser();
  const settings = useSettings();
  const userId = error ? undefined : user?.id;
  const jellyfinUsername = error ? undefined : user?.jellyfinUsername;
  const userUpdatedAt = error ? '' : String(user?.updatedAt ?? '');
  const mediaServerType = settings.currentSettings.mediaServerType;
  const isJellyfin = mediaServerType === MediaServerType.JELLYFIN;

  const clearSession = useCallback(() => {
    const host = window.foreseerNative;
    if (isUsableForeseerNative(host)) {
      sendNativeCommand(host, {
        type: 'session.clear',
        id: createRequestId(),
      });
    }
    activePlayRequestId.current = undefined;
    window.clearTimeout(activePlayTimeout.current);
    setState('web');
  }, []);

  useEffect(() => {
    const host = window.foreseerNative;
    if (!isUsableForeseerNative(host) || loading) {
      if (!isUsableForeseerNative(host)) setState('web');
      return;
    }

    const identityChanged =
      !hasObservedUserState.current ||
      previousUserId.current !== userId ||
      previousJellyfinUsername.current !== jellyfinUsername ||
      previousUserUpdatedAt.current !== userUpdatedAt ||
      previousMediaServerType.current !== mediaServerType;
    if (identityChanged) {
      const cleared = sendNativeCommand(host, {
        type: 'session.clear',
        id: createRequestId(),
      });
      if (!cleared) {
        setState('degraded');
        const retry = window.setTimeout(
          () => setSessionResetRetry((attempt) => attempt + 1),
          5_000
        );
        return () => window.clearTimeout(retry);
      }

      activePlayRequestId.current = undefined;
      window.clearTimeout(activePlayTimeout.current);
      hasObservedUserState.current = true;
      previousUserId.current = userId;
      previousJellyfinUsername.current = jellyfinUsername;
      previousUserUpdatedAt.current = userUpdatedAt;
      previousMediaServerType.current = mediaServerType;
    }

    if (!userId || !isJellyfin || !jellyfinUsername) {
      setState('web');
      return;
    }

    setState('probing');
    let authRequestId: string | undefined;
    let authInFlight = false;
    let authReady = false;
    let ticketRequestPending = false;
    let suppressRetries = false;
    let disposed = false;
    let authTimeout: number | undefined;

    const degradeAuthentication = () => {
      authInFlight = false;
      authReady = false;
      ticketRequestPending = false;
      authRequestId = undefined;
      window.clearTimeout(authTimeout);
      if (!disposed) setState('degraded');
    };

    const bootstrap = () => {
      if (disposed || suppressRetries || authInFlight || authReady) return;
      authRequestId = createRequestId();
      authInFlight = true;
      setState('authenticating');
      if (
        !sendNativeCommand(host, {
          type: 'auth.challenge',
          id: authRequestId,
        })
      ) {
        degradeAuthentication();
        return;
      }
      authTimeout = window.setTimeout(degradeAuthentication, 30_000);
    };

    const clearActivePlay = (failed: boolean) => {
      activePlayRequestId.current = undefined;
      window.clearTimeout(activePlayTimeout.current);
      setState(failed ? 'degraded' : 'ready');
    };

    const onNativeEvent = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isForeseerNativeEventV1(detail)) return;

      const isAuthEvent = detail.id === authRequestId;
      const isPlayEvent = detail.id === activePlayRequestId.current;
      if (
        detail.type === 'auth-challenge' &&
        isAuthEvent &&
        authInFlight &&
        !ticketRequestPending &&
        typeof detail.challenge === 'string' &&
        nativeRuntimeProtocolV1.challengePattern.test(detail.challenge)
      ) {
        ticketRequestPending = true;
        void axios
          .post<AuthTicketResponse>('/api/v1/desktop/auth-tickets', {
            challenge: detail.challenge,
            protocolVersion: nativeRuntimeProtocolV1.protocolVersion,
          })
          .then(({ data }) => {
            if (disposed || detail.id !== authRequestId || !authInFlight)
              return;
            if (!nativeRuntimeProtocolV1.ticketPattern.test(data.ticket)) {
              degradeAuthentication();
              return;
            }
            if (
              !sendNativeCommand(host, {
                type: 'auth.complete',
                id: detail.id,
                ticket: data.ticket,
              })
            ) {
              degradeAuthentication();
            }
          })
          .catch((requestError: unknown) => {
            if (
              axios.isAxiosError(requestError) &&
              [401, 403, 409].includes(requestError.response?.status ?? 0)
            ) {
              suppressRetries = true;
            }
            degradeAuthentication();
          });
        return;
      }

      if (detail.type === 'ready' && isAuthEvent && authInFlight) {
        authInFlight = false;
        authReady = true;
        authRequestId = undefined;
        window.clearTimeout(authTimeout);
        setState('ready');
        return;
      }
      if (detail.type === 'error' && isAuthEvent) {
        degradeAuthentication();
        return;
      }

      if (
        isPlayEvent &&
        ['accepted', 'resolving', 'starting', 'playing'].includes(detail.type)
      ) {
        if (detail.type === 'playing') {
          window.clearTimeout(activePlayTimeout.current);
        }
        setState('playing');
        return;
      }
      if (
        isPlayEvent &&
        ['stopped', 'finished', 'canceled', 'error'].includes(detail.type)
      ) {
        clearActivePlay(detail.type === 'error');
        return;
      }
      if (detail.type === 'runtime-failed') {
        activePlayRequestId.current = undefined;
        window.clearTimeout(activePlayTimeout.current);
        authInFlight = false;
        authReady = false;
        ticketRequestPending = false;
        authRequestId = undefined;
        window.clearTimeout(authTimeout);
        setState('degraded');
        return;
      }
      if (detail.type === 'runtime-recovered') {
        if (authInFlight || authReady) return;
        authInFlight = false;
        authReady = false;
        ticketRequestPending = false;
        authRequestId = undefined;
        window.clearTimeout(authTimeout);
        if (
          sendNativeCommand(host, {
            type: 'session.clear',
            id: createRequestId(),
          })
        ) {
          bootstrap();
        } else {
          setState('degraded');
        }
      }
    };

    window.addEventListener(nativeRuntimeProtocolV1.eventName, onNativeEvent);
    bootstrap();
    const retry = window.setInterval(bootstrap, 15_000);

    return () => {
      disposed = true;
      authInFlight = false;
      ticketRequestPending = false;
      authRequestId = undefined;
      window.clearInterval(retry);
      window.clearTimeout(authTimeout);
      window.removeEventListener(
        nativeRuntimeProtocolV1.eventName,
        onNativeEvent
      );
    };
  }, [
    isJellyfin,
    jellyfinUsername,
    loading,
    mediaServerType,
    sessionResetRetry,
    userId,
    userUpdatedAt,
  ]);

  const playItem = useCallback(
    (itemId: string): boolean => {
      if (
        (state !== 'ready' && state !== 'playing') ||
        itemId.length === 0 ||
        itemId.length > nativeRuntimeProtocolV1.itemIdMaxLength
      ) {
        return false;
      }

      const host = window.foreseerNative;
      if (!isUsableForeseerNative(host)) return false;
      const requestId = createRequestId();
      activePlayRequestId.current = requestId;
      window.clearTimeout(activePlayTimeout.current);
      if (
        !sendNativeCommand(host, {
          type: 'play.item',
          id: requestId,
          itemId,
        })
      ) {
        if (activePlayRequestId.current === requestId) {
          activePlayRequestId.current = undefined;
          window.clearTimeout(activePlayTimeout.current);
        }
        setState('degraded');
        return false;
      }

      if (activePlayRequestId.current === requestId) {
        activePlayTimeout.current = window.setTimeout(() => {
          if (activePlayRequestId.current === requestId) {
            activePlayRequestId.current = undefined;
            setState('degraded');
          }
        }, 30_000);
        setState('playing');
      }
      return true;
    },
    [state]
  );

  const value = useMemo(
    () => ({ playItem, clearSession }),
    [playItem, clearSession]
  );
  return (
    <NativeRuntimeContext.Provider value={value}>
      {children}
    </NativeRuntimeContext.Provider>
  );
};

export const useNativeRuntime = (): NativeRuntimeContextValue =>
  useContext(NativeRuntimeContext);
