import { compactSelectComponents } from '@app/components/Selector';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import debounce from 'lodash/debounce';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import AsyncSelect from 'react-select/async';

const messages = defineMessages('components.MusicArtistFilter', {
  artist: 'Artist',
  placeholder: 'Search artists…',
  start: 'Start typing to search.',
  empty: 'No matching artists',
  failed: 'Artist search unavailable. Try again.',
});
type ArtistOption = { label: string; value: string; name: string };

export default function MusicArtistFilter({
  className = '',
}: {
  className?: string;
}) {
  const intl = useIntl();
  const router = useRouter();
  const update = useBatchUpdateQueryParams({});
  const [failed, setFailed] = useState(false);
  const artist =
    typeof router.query.artist === 'string' ? router.query.artist : '';
  const artistId =
    typeof router.query.artistId === 'string' ? router.query.artistId : '';
  const loadOptions = useCallback(
    async (input: string): Promise<ArtistOption[]> => {
      setFailed(false);
      if (!input.trim()) return [];
      try {
        const response = await axios.get<{
          results: {
            id: string;
            name: string;
            mediaType: string;
            disambiguation?: string;
          }[];
        }>('/api/v1/search', {
          params: { query: encodeURIExtraParams(input.trim()), type: 'artist' },
        });
        return response.data.results
          .filter((item) => item.mediaType === 'artist')
          .map((item) => ({
            name: item.name,
            value: item.id,
            label: item.disambiguation
              ? `${item.name} (${item.disambiguation})`
              : item.name,
          }));
      } catch {
        setFailed(true);
        return [];
      }
    },
    []
  );
  const debouncedLoad = useMemo(
    () =>
      debounce((input: string, callback: (options: ArtistOption[]) => void) => {
        void loadOptions(input).then(callback);
      }, 350),
    [loadOptions]
  );
  useEffect(() => () => debouncedLoad.cancel(), [debouncedLoad]);
  return (
    <div className={`discover-filter-control music-artist-filter ${className}`}>
      <span
        className={`discover-filter-control-label ${artistId || artist ? 'discover-filter-control-label-active' : ''}`}
      >
        {intl.formatMessage(messages.artist)}
      </span>
      <AsyncSelect<ArtistOption, false>
        inputId="music-artist-filter"
        instanceId="music-artist-filter"
        aria-label={intl.formatMessage(messages.artist)}
        className="react-select-container discover-compact-select"
        classNamePrefix="react-select"
        unstyled
        components={compactSelectComponents}
        isClearable
        cacheOptions
        value={artist ? { name: artist, label: artist, value: artistId } : null}
        loadOptions={debouncedLoad}
        placeholder={intl.formatMessage(messages.placeholder)}
        noOptionsMessage={({ inputValue }) =>
          intl.formatMessage(
            failed
              ? messages.failed
              : inputValue
                ? messages.empty
                : messages.start
          )
        }
        onChange={(option) =>
          update({
            artist: option?.name,
            artistId: option?.value || undefined,
            page: undefined,
          })
        }
      />
    </div>
  );
}
