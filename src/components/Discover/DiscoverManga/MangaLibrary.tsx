import Alert from '@app/components/Common/Alert';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useDiscoverScrollRestoration from '@app/hooks/useDiscoverScrollRestoration';
import defineMessages from '@app/utils/defineMessages';
import { MANGA_LIBRARY_URL } from '@app/utils/mangaLibrary';
import type { MangaResult } from '@server/models/Manga';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Discover.DiscoverManga.MangaLibrary',
  {
    mangaLibrary: 'Your Manga Library',
    unavailable: 'Your manga library is unavailable right now.',
  }
);

/** Every title in the manga library, most recently added first. */
const MangaLibrary = () => {
  const intl = useIntl();
  const discover = useDiscover<MangaResult>(
    MANGA_LIBRARY_URL,
    {},
    { showErrorToast: false, hideErrorWithResults: false }
  );
  useDiscoverScrollRestoration({
    mediaType: 'manga',
    itemCount: discover.titles.length,
    shuffleSeed: discover.shuffleSeed,
    isLoading: discover.isLoadingInitialData || discover.isLoadingMore,
    isReachingEnd: discover.isReachingEnd,
    fetchMore: discover.fetchMore,
  });

  const title = intl.formatMessage(messages.mangaLibrary);
  const providerMessage = (
    discover.error as { response?: { data?: { message?: string } } } | undefined
  )?.response?.data?.message;

  return (
    <>
      <PageTitle title={title} />
      <Header>{title}</Header>
      {discover.error && (
        <Alert
          title={providerMessage ?? intl.formatMessage(messages.unavailable)}
          type="warning"
        />
      )}
      {(!discover.error || discover.titles.length > 0) && (
        <ListView
          items={discover.titles}
          isEmpty={discover.isEmpty}
          isLoading={
            discover.isLoadingInitialData ||
            (discover.isLoadingMore && discover.titles.length > 0)
          }
          isReachingEnd={discover.isReachingEnd}
          onScrollBottom={discover.fetchMore}
        />
      )}
    </>
  );
};

export default MangaLibrary;
