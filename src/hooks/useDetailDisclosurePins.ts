import { useUser, type UserSettings } from '@app/hooks/useUser';
import type {
  DetailDisclosureMediaType,
  DetailDisclosurePin,
  UserSettingsDetailDisclosureResponse,
} from '@server/interfaces/api/userSettingsInterfaces';
import axios from 'axios';
import { useCallback, useMemo, useRef } from 'react';
import useSWR from 'swr';
import {
  DetailDisclosurePinsMutationState,
  type DetailDisclosurePins,
} from './detailDisclosurePinsMutation';

const defaultPins: DetailDisclosurePins = {
  details: false,
  advancedOptions: false,
  filters: false,
  mediaFilters: false,
  sortBy: false,
  collection: false,
  cast: false,
  crew: false,
  artists: false,
  subjectTags: false,
};

const fromUserSettings = (
  settings: UserSettings | undefined,
  mediaType: DetailDisclosureMediaType
): DetailDisclosurePins => {
  const legacyPins: DetailDisclosurePins = {
    details: false,
    advancedOptions: false,
    filters: false,
    mediaFilters: false,
    sortBy: false,
    collection: false,
    cast:
      mediaType === 'movie' && settings?.detailDisclosureCastPinned === true,
    crew:
      mediaType === 'movie' && settings?.detailDisclosureCrewPinned === true,
    artists:
      mediaType === 'music' && settings?.detailDisclosureArtistsPinned === true,
    subjectTags:
      mediaType === 'movie' &&
      settings?.detailDisclosureSubjectTagsPinned === true,
  };

  return {
    ...legacyPins,
    ...settings?.detailDisclosurePins?.[mediaType],
  };
};

const useDetailDisclosurePins = (mediaType: DetailDisclosureMediaType) => {
  const { user, revalidate: revalidateUser } = useUser();
  const userId = String(user?.id ?? '').match(/^[1-9]\d{0,8}$/)?.[0] ?? null;
  const userKey = `${userId ? String(userId) : 'anonymous'}:${mediaType}`;
  const endpoint = !userId
    ? null
    : mediaType === 'movie'
      ? `/api/v1/user/${userId}/settings/detail-disclosures/movie`
      : mediaType === 'tv'
        ? `/api/v1/user/${userId}/settings/detail-disclosures/tv`
        : mediaType === 'music'
          ? `/api/v1/user/${userId}/settings/detail-disclosures/music`
          : `/api/v1/user/${userId}/settings/detail-disclosures/book`;
  const { data, mutate } = useSWR<UserSettingsDetailDisclosureResponse>(
    endpoint,
    {
      fallbackData: fromUserSettings(user?.settings, mediaType),
      revalidateOnFocus: false,
    }
  );
  const pins = useMemo<DetailDisclosurePins>(
    () => ({
      ...defaultPins,
      ...fromUserSettings(user?.settings, mediaType),
      ...data,
    }),
    [data, mediaType, user?.settings]
  );
  const mutationState = useRef(new DetailDisclosurePinsMutationState());
  mutationState.current.synchronize(userKey, pins);

  const setPinned = useCallback(
    async (section: DetailDisclosurePin, pinned: boolean): Promise<void> => {
      if (!endpoint) {
        return;
      }

      const mutation = mutationState.current.begin(section, pinned);
      try {
        const savedPins = await mutate(
          async () => {
            const response =
              await axios.post<UserSettingsDetailDisclosureResponse>(endpoint, {
                [section]: pinned,
              });
            return response.data;
          },
          {
            optimisticData: mutation.next,
            rollbackOnError: () => mutationState.current.isCurrent(mutation),
            revalidate: false,
          }
        );

        if (mutationState.current.isCurrent(mutation) && savedPins) {
          const normalizedPins = { ...defaultPins, ...savedPins };
          mutationState.current.synchronize(userKey, normalizedPins);
          await revalidateUser();
        }
      } catch (error) {
        const rollbackPins = mutationState.current.rollback(mutation);
        if (rollbackPins) {
          await mutate(rollbackPins, { revalidate: false });
        }
        throw error;
      }
    },
    [endpoint, mutate, revalidateUser, userKey]
  );

  const togglePinned = useCallback(
    async (section: DetailDisclosurePin): Promise<void> => {
      await setPinned(section, !pins[section]);
    },
    [pins, setPinned]
  );

  return { pins, setPinned, togglePinned };
};

export default useDetailDisclosurePins;
