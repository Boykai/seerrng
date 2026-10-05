import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon, ChevronDownIcon } from '@heroicons/react/24/solid';
import { MediaType } from '@server/constants/media';
import type {
  RequestDownloadAssetResponse,
  RequestDownloadAssetsResponse,
  RequestStatusResultsResponse,
} from '@server/interfaces/api/requestInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

type ReaderDownloadMediaType =
  MediaType.BOOK | MediaType.COMIC | MediaType.MAGAZINE;
type BookDownloadFormat = 'ebook' | 'audiobook';

interface RequestDownloadActionProps {
  mediaId: number;
  mediaType: ReaderDownloadMediaType;
  bookFormat?: BookDownloadFormat;
}

interface RequestDownloadAsset extends RequestDownloadAssetResponse {
  requestId: number;
}

const messages = defineMessages('components.RequestDownloadAction', {
  ebook: 'Download ebook',
  audiobook: 'Download audiobook',
  comic: 'Download comic',
  magazine: 'Download issue',
  chooseEbooks: 'Choose an ebook file',
  chooseAudiobooks: 'Choose an audiobook file',
  chooseComics: 'Choose comic issues',
  chooseMagazines: 'Choose magazine issues',
  downloadFor: 'Download {name}',
  downloadHelp:
    'Downloads this available file to the device using this browser. Open it in a compatible reader app.',
  checking: 'Checking for available files…',
  unavailable:
    'Could not check these downloads. Review this title in Request Status and try again.',
  partiallyAvailable:
    'Some files could not be checked. Review this title in Request Status for other copies.',
  notFound:
    'No downloadable copy was found. Review Request Status and check that the file is present in its media service.',
  requestStatus: 'Request Status',
});

type ActionLabelKey = 'ebook' | 'audiobook' | 'comic' | 'magazine';
type ChooseLabelKey =
  'chooseEbooks' | 'chooseAudiobooks' | 'chooseComics' | 'chooseMagazines';

const formatMatches = (
  requestFormat: string | null | undefined,
  bookFormat: BookDownloadFormat
): boolean => {
  const normalizedFormat = requestFormat ?? 'ebook';
  return normalizedFormat === bookFormat || normalizedFormat === 'both';
};

export const filterRequestDownloadAssets = (
  assets: RequestDownloadAssetResponse[],
  mediaType: ReaderDownloadMediaType,
  bookFormat?: BookDownloadFormat
): RequestDownloadAssetResponse[] =>
  assets.filter(
    (asset) =>
      mediaType !== MediaType.BOOK || !bookFormat || asset.format === bookFormat
  );

const getActionLabel = (
  mediaType: ReaderDownloadMediaType,
  bookFormat?: BookDownloadFormat
): ActionLabelKey => {
  if (mediaType === MediaType.BOOK) {
    return bookFormat === 'audiobook' ? 'audiobook' : 'ebook';
  }
  return mediaType === MediaType.COMIC ? 'comic' : 'magazine';
};

const getChooseLabel = (
  mediaType: ReaderDownloadMediaType,
  bookFormat?: BookDownloadFormat
): ChooseLabelKey => {
  if (mediaType === MediaType.BOOK) {
    return bookFormat === 'audiobook' ? 'chooseAudiobooks' : 'chooseEbooks';
  }
  return mediaType === MediaType.COMIC ? 'chooseComics' : 'chooseMagazines';
};

const RequestDownloadAction = ({
  mediaId,
  mediaType,
  bookFormat,
}: RequestDownloadActionProps) => {
  const intl = useIntl();
  const { user } = useUser();
  const params = new URLSearchParams({
    take: '100',
    skip: '0',
    requestedBy: String(user?.id ?? ''),
    mediaType,
    timeFrame: 'all',
    filter: 'available',
    sort: 'added',
    sortDirection: 'desc',
    mediaId: String(mediaId),
  });
  if (mediaType === MediaType.BOOK && bookFormat) {
    params.set('bookFormat', bookFormat);
  }

  const statusUrl = '/api/v1/request/status?' + params.toString();
  const {
    data: requestStatus,
    error: requestStatusError,
    isLoading: isLoadingRequestStatus,
  } = useSWR<RequestStatusResultsResponse>(user?.id ? statusUrl : null, {
    revalidateOnFocus: false,
  });
  const requestIds =
    requestStatus?.results
      .filter(({ status, request }) => {
        if (String(status.stage) !== 'available') return false;
        return (
          mediaType !== MediaType.BOOK ||
          !bookFormat ||
          formatMatches(request.bookFormat, bookFormat)
        );
      })
      .map(({ request }) => request.id) ?? [];
  const requestStatusHref = requestIds[0]
    ? '/requests?requestId=' + requestIds[0]
    : '/requests';
  const requestIdsKey = requestIds.join(',');

  const { data, error, isLoading } = useSWR<{
    assets: RequestDownloadAsset[];
    hadErrors: boolean;
  }>(
    requestIds.length > 0
      ? 'request-reader-downloads:' +
          mediaType +
          ':' +
          (bookFormat ?? 'all') +
          ':' +
          requestIdsKey
      : null,
    async () => {
      let nextRequestIndex = 0;
      const worker = async () => {
        const assets: RequestDownloadAsset[] = [];
        let hadErrors = false;

        while (nextRequestIndex < requestIds.length) {
          const requestId = requestIds[nextRequestIndex++];
          if (requestId === undefined) continue;

          try {
            const response = await axios.get<RequestDownloadAssetsResponse>(
              '/api/v1/request/status/' + requestId + '/downloads'
            );
            const results = Array.isArray(response.data.results)
              ? response.data.results
              : [];
            hadErrors ||= response.data.hadErrors === true;
            assets.push(
              ...filterRequestDownloadAssets(
                results,
                mediaType,
                bookFormat
              ).map((asset) => ({ ...asset, requestId }))
            );
          } catch {
            hadErrors = true;
          }
        }

        return { assets, hadErrors };
      };

      const workers = await Promise.all(
        Array.from({ length: Math.min(requestIds.length, 4) }, () => worker())
      );
      const uniqueAssets = new Map<string, RequestDownloadAsset>();

      for (const asset of workers.flatMap((result) => result.assets)) {
        const key = asset.requestId + ':' + asset.id;
        if (!uniqueAssets.has(key)) uniqueAssets.set(key, asset);
      }

      return {
        assets: [...uniqueAssets.values()].sort((left, right) =>
          left.name.localeCompare(right.name)
        ),
        hadErrors: workers.some((result) => result.hadErrors),
      };
    },
    { revalidateOnFocus: false }
  );

  const requestStatusLink = (
    <Link href={requestStatusHref}>
      {intl.formatMessage(messages.requestStatus)}
    </Link>
  );
  const mediaLabel = intl.formatMessage(
    messages[getActionLabel(mediaType, bookFormat)]
  );
  const chooseLabel = intl.formatMessage(
    messages[getChooseLabel(mediaType, bookFormat)]
  );
  const downloadHref = (asset: RequestDownloadAsset) =>
    '/api/v1/request/status/' + asset.requestId + '/downloads/' + asset.id;

  if (!user?.id) return null;
  if (isLoadingRequestStatus || (requestIds.length > 0 && isLoading)) {
    return (
      <Button buttonType="primary" buttonSize="sm" disabled>
        <ArrowDownTrayIcon aria-hidden="true" />
        <span>{intl.formatMessage(messages.checking)}</span>
      </Button>
    );
  }

  if (!requestStatus && requestStatusError) {
    return (
      <span role="status">
        {intl.formatMessage(messages.unavailable)} {requestStatusLink}
      </span>
    );
  }
  if (requestIds.length === 0) return null;

  if (!data && error) {
    return (
      <span role="status">
        {intl.formatMessage(messages.unavailable)} {requestStatusLink}
      </span>
    );
  }

  const assets = data?.assets ?? [];
  if (assets.length === 0) {
    return data?.hadErrors ? (
      <span role="status">
        {intl.formatMessage(messages.unavailable)} {requestStatusLink}
      </span>
    ) : data ? (
      <span role="status">
        {intl.formatMessage(messages.notFound)} {requestStatusLink}
      </span>
    ) : null;
  }

  const partialCheckNotice = data?.hadErrors ? (
    <span role="status">
      {intl.formatMessage(messages.partiallyAvailable)} {requestStatusLink}
    </span>
  ) : null;

  if (assets.length === 1) {
    const asset = assets[0];
    return (
      <>
        <Tooltip content={intl.formatMessage(messages.downloadHelp)}>
          <Button
            as="a"
            href={asset ? downloadHref(asset) : undefined}
            download
            buttonType="primary"
            buttonSize="sm"
            aria-label={intl.formatMessage(messages.downloadFor, {
              name: asset?.name ?? mediaLabel,
            })}
          >
            <ArrowDownTrayIcon aria-hidden="true" />
            <span>{mediaLabel}</span>
          </Button>
        </Tooltip>
        {partialCheckNotice}
      </>
    );
  }

  return (
    <>
      <details>
        <summary className="app-button app-button-primary button-sm">
          <ArrowDownTrayIcon className="app-action-icon" aria-hidden="true" />
          {chooseLabel}
          <ChevronDownIcon
            className="app-disclosure-chevron"
            aria-hidden="true"
          />
        </summary>
        <ol className="app-dropdown-menu app-download-menu">
          {assets.map((asset) => (
            <li key={asset.requestId + ':' + asset.id}>
              <a
                href={downloadHref(asset)}
                download
                className="app-dropdown-item app-download-item"
                aria-label={intl.formatMessage(messages.downloadFor, {
                  name: asset.name,
                })}
              >
                {asset.name}
              </a>
            </li>
          ))}
        </ol>
      </details>
      {partialCheckNotice}
    </>
  );
};

export default RequestDownloadAction;
