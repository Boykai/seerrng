import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import SelectionCircle from '@app/components/Common/SelectionCircle';
import {
  messages,
  searchMessages,
  trackingMessages,
} from '@app/components/Settings/MangaLibrary/messages';
import useDebouncedState from '@app/hooks/useDebouncedState';
import globalMessages from '@app/i18n/globalMessages';
import { Transition } from '@headlessui/react';
import type { MangaResult } from '@server/models/Manga';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

// Matches the catalog route's query limit.
const MAX_QUERY_LENGTH = 256;

interface MangaSearchResponse {
  results: MangaResult[];
}

export const mangaSearchKey = (query: string): string | null => {
  const trimmed = query.trim();
  return trimmed
    ? `/api/v1/discover/manga?query=${encodeURIComponent(trimmed)}`
    : null;
};

interface BindModalProps {
  /** The Suwayomi title, shown as text only. */
  libraryTitle: string | null;
  busy: boolean;
  onBind: (anilistId: number) => void;
  onCancel: () => void;
}

/**
 * Picks the AniList title for a library item from the catalog search. The
 * AniList ID always comes from a search result, never from typed input.
 */
const BindModal = ({
  libraryTitle,
  busy,
  onBind,
  onCancel,
}: BindModalProps) => {
  const intl = useIntl();
  const [search, debouncedSearch, setSearch] = useDebouncedState('');
  const [selected, setSelected] = useState<number | null>(null);
  const key = mangaSearchKey(debouncedSearch);
  const { data, error } = useSWR<MangaSearchResponse>(key, {
    keepPreviousData: false,
  });
  const results = key ? (data?.results ?? []) : [];

  // A new search drops the pick, so OK never confirms a hidden title.
  useEffect(() => {
    setSelected(null);
  }, [key]);

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(messages.chooseTitle)}
        subTitle={libraryTitle ?? undefined}
        onCancel={onCancel}
        okButtonType="primary"
        okText={intl.formatMessage(
          busy ? globalMessages.saving : trackingMessages.confirm
        )}
        okDisabled={busy || selected === null}
        onOk={() => {
          if (selected !== null && !busy) onBind(selected);
        }}
      >
        <div className="form-row">
          <label htmlFor="mangaLibrarySearch" className="text-label">
            {intl.formatMessage(searchMessages.search)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <input
                id="mangaLibrarySearch"
                type="text"
                value={search}
                maxLength={MAX_QUERY_LENGTH}
                placeholder={intl.formatMessage(searchMessages.searchManga)}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <span className="settings-form-row-description">
            {intl.formatMessage(messages.bindTip)}
          </span>
          {key && error ? (
            <span className="settings-form-row-description" role="alert">
              {intl.formatMessage(globalMessages.error)}
            </span>
          ) : key && !data ? (
            <span className="settings-form-row-description">
              {intl.formatMessage(globalMessages.loading)}
            </span>
          ) : key && results.length === 0 ? (
            <span className="settings-form-row-description">
              {intl.formatMessage(globalMessages.noresults)}
            </span>
          ) : (
            results.length > 0 && (
              <ul className="settings-library-grid col-span-full lg:grid-cols-2">
                {results.map((manga) => (
                  <li
                    key={manga.id}
                    className="app-card-sub settings-library-card col-span-1 flex shadow-sm"
                  >
                    <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      <div className="settings-library-card-content">
                        <span className="truncate">{manga.title}</span>
                        {manga.startYear && (
                          <Badge badgeType="light">{manga.startYear}</Badge>
                        )}
                      </div>
                      <div className="flex-shrink-0">
                        <SelectionCircle
                          selected={selected === manga.id}
                          disabled={busy}
                          label={manga.title}
                          onClick={() =>
                            setSelected((current) =>
                              current === manga.id ? null : manga.id
                            )
                          }
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </Modal>
    </Transition>
  );
};

export default BindModal;
