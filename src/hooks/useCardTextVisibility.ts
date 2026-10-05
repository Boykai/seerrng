import type { UserSettings } from '@app/hooks/useUser';
import { useUser } from '@app/hooks/useUser';
import type {
  CardTextVisibility,
  UserSettingsCardTextResponse,
} from '@server/interfaces/api/userSettingsInterfaces';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { CardTextVisibilityMutationState } from './cardTextVisibilityMutation';

type CardTextMediaType = keyof UserSettingsCardTextResponse;

const storageKeyPrefix = 'seerr.cardTextVisibility';

export const getCardTextVisibilityStorageKey = (userId?: number): string =>
  `${storageKeyPrefix}:${
    Number.isSafeInteger(userId) && (userId ?? 0) > 0 ? userId : 'anonymous'
  }`;

const defaultCardTextVisibility: Required<UserSettingsCardTextResponse> = {
  movie: 'hover',
  tv: 'hover',
  album: 'always',
  book: 'always',
  manga: 'hover',
};

const isCardTextVisibility = (value: unknown): value is CardTextVisibility =>
  value === 'always' || value === 'hover';

const readStoredVisibility = (
  storageKey: string
): UserSettingsCardTextResponse => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey) ?? '{}'
    ) as Record<string, unknown>;

    return {
      movie: isCardTextVisibility(parsed.movie) ? parsed.movie : undefined,
      tv: isCardTextVisibility(parsed.tv) ? parsed.tv : undefined,
      album: isCardTextVisibility(parsed.album) ? parsed.album : undefined,
      book: isCardTextVisibility(parsed.book) ? parsed.book : undefined,
      manga: isCardTextVisibility(parsed.manga) ? parsed.manga : undefined,
    };
  } catch {
    return {};
  }
};

const writeStoredVisibility = (
  storageKey: string,
  visibility: UserSettingsCardTextResponse
): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(visibility));
  } catch {
    // Local storage is a convenience fallback; server persistence still applies.
  }
};

const fromUserSettings = (
  settings?: UserSettings
): UserSettingsCardTextResponse => ({
  movie:
    settings?.cardTextVisibility?.movie ?? settings?.cardTextVisibilityMovie,
  tv: settings?.cardTextVisibility?.tv ?? settings?.cardTextVisibilityTv,
  album:
    settings?.cardTextVisibility?.album ?? settings?.cardTextVisibilityAlbum,
  book: settings?.cardTextVisibility?.book ?? settings?.cardTextVisibilityBook,
  manga:
    settings?.cardTextVisibility?.manga ?? settings?.cardTextVisibilityManga,
});

const useCardTextVisibility = () => {
  const { user, revalidate: revalidateUser } = useUser();
  const localStorageKey = getCardTextVisibilityStorageKey(user?.id);
  const [storedVisibility, setStoredVisibility] = useState<{
    key?: string;
    value: UserSettingsCardTextResponse;
  }>({ value: {} });
  const localVisibility = useMemo(
    () =>
      storedVisibility.key === localStorageKey ? storedVisibility.value : {},
    [localStorageKey, storedVisibility]
  );
  const endpoint = user?.id
    ? `/api/v1/user/${user.id}/settings/card-text`
    : null;
  const { data, mutate } = useSWR<UserSettingsCardTextResponse>(endpoint, {
    fallbackData: fromUserSettings(user?.settings),
    revalidateOnFocus: false,
  });

  useEffect(() => {
    setStoredVisibility({
      key: localStorageKey,
      value: readStoredVisibility(localStorageKey),
    });
  }, [localStorageKey]);

  const visibility = useMemo(
    () => ({
      ...defaultCardTextVisibility,
      ...localVisibility,
      ...fromUserSettings(user?.settings),
      ...data,
    }),
    [data, localVisibility, user?.settings]
  );
  const mutationState = useRef(new CardTextVisibilityMutationState());
  mutationState.current.synchronize(localStorageKey, visibility);

  const setVisibility = useCallback(
    async (
      mediaType: CardTextMediaType,
      nextVisibility: CardTextVisibility
    ): Promise<void> => {
      const mutation = mutationState.current.begin(mediaType, nextVisibility);
      const nextValue = mutation.next;

      setStoredVisibility({ key: localStorageKey, value: nextValue });
      writeStoredVisibility(localStorageKey, nextValue);

      if (!endpoint) {
        return;
      }

      try {
        const savedVisibility = await mutate(
          async () => {
            const response = await axios.post<UserSettingsCardTextResponse>(
              endpoint,
              {
                [mediaType]: nextVisibility,
              }
            );
            return response.data;
          },
          {
            optimisticData: nextValue,
            rollbackOnError: () => mutationState.current.isCurrent(mutation),
            revalidate: false,
          }
        );
        if (mutationState.current.isCurrent(mutation) && savedVisibility) {
          mutationState.current.synchronize(localStorageKey, savedVisibility);
          setStoredVisibility({
            key: localStorageKey,
            value: savedVisibility,
          });
          writeStoredVisibility(localStorageKey, savedVisibility);
          await revalidateUser();
        }
      } catch (e) {
        const rollbackVisibility = mutationState.current.rollback(mutation);
        if (!rollbackVisibility) {
          throw e;
        }
        setStoredVisibility({
          key: localStorageKey,
          value: rollbackVisibility,
        });
        writeStoredVisibility(localStorageKey, rollbackVisibility);
        throw e;
      }
    },
    [endpoint, localStorageKey, mutate, revalidateUser]
  );

  const toggleVisibility = useCallback(
    async (mediaType: CardTextMediaType): Promise<void> => {
      await setVisibility(
        mediaType,
        visibility[mediaType] === 'always' ? 'hover' : 'always'
      );
    },
    [setVisibility, visibility]
  );

  return {
    visibility,
    setVisibility,
    toggleVisibility,
  };
};

export default useCardTextVisibility;
