import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import PageErrorMessage from '@app/components/Common/PageErrorMessage';
import PaginationFooter from '@app/components/Common/PaginationFooter';
import Table from '@app/components/Common/Table';
import type { MediaAvailabilityTone } from '@app/components/MediaDetails/AvailabilityValue';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import globalMessages from '@app/i18n/globalMessages';
import { encodeApiPathSegment } from '@app/utils/apiPath';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import type {
  MangaChapterPageResponse,
  MangaChapterResult,
  MangaChapterStatus,
} from '@server/interfaces/api/mangaChapterInterfaces';
import { useEffect, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MangaDetails.MangaChapterList', {
  chapters: 'Chapters',
  chapter: 'Chapter',
  name: 'Name',
  uploaded: 'Uploaded',
  unknown: 'Unknown',
  downloaded: 'Downloaded',
  downloadChapter: 'Download chapter {chapter}',
  downloadHelp: 'Download your copy of this chapter.',
  noChapters: 'No Chapters',
  noChaptersDescription: 'The library has no chapters for this title yet.',
  notInLibrary: 'Not in the Library Yet',
  notInLibraryDescription:
    'Chapters appear here once this title is in the library.',
  unavailable: 'Chapters Unavailable',
  unavailableDescription: 'The chapter list could not be loaded right now.',
  rateLimited: 'Too many requests right now. Try again in a moment.',
  retryTooltip: 'Load the chapter list again.',
});

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const MISSING_VALUE = '—';

const chapterStatuses: Record<
  MangaChapterStatus,
  { message: MessageDescriptor; tone: MediaAvailabilityTone }
> = {
  available: { message: messages.downloaded, tone: 'available' },
  requested: { message: globalMessages.requested, tone: 'processing' },
  notRequested: { message: globalMessages.notrequested, tone: 'unavailable' },
};

interface ErrorResponse {
  response?: { status?: number };
}

const MangaChapterList = ({ mangaId }: { mangaId: number }) => {
  const intl = useIntl();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, error, isValidating, mutate } =
    useSWR<MangaChapterPageResponse>(
      `/api/v1/manga/${encodeApiPathSegment(mangaId)}/chapters?page=${page}&pageSize=${pageSize}`,
      { keepPreviousData: true }
    );
  // The previous page only keeps the page count and footer while the next
  // page loads or fails, so the reader can still page back.
  const current =
    data?.pageInfo.page === page && data.pageInfo.pageSize === pageSize
      ? data
      : undefined;
  const pages = Math.max(data?.pageInfo.pages ?? 1, 1);

  useEffect(() => {
    // A list that shrank keeps the reader on its new last page.
    if (current && page > pages) setPage(pages);
  }, [current, page, pages]);

  const chapterLabel = (chapter: MangaChapterResult) =>
    chapter.number === null
      ? intl.formatMessage(messages.unknown)
      : intl.formatNumber(chapter.number, { useGrouping: false });
  const uploadedLabel = (uploadedAt: string | null) =>
    uploadedAt
      ? intl.formatDate(uploadedAt, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : MISSING_VALUE;
  const errorStatus = (error as ErrorResponse | undefined)?.response?.status;

  return (
    <section
      className="app-card-inset refreshed-inset-surface card-spacing-before"
      aria-labelledby="manga-chapter-list-heading"
    >
      <h2
        id="manga-chapter-list-heading"
        className="media-inset-heading detail-card-heading-after"
      >
        {intl.formatMessage(messages.chapters)}
      </h2>
      {error && (
        <PageErrorMessage
          title={intl.formatMessage(messages.unavailable)}
          description={intl.formatMessage(
            errorStatus === 429
              ? messages.rateLimited
              : messages.unavailableDescription
          )}
          retry={{
            onClick: () => mutate(),
            tooltip: intl.formatMessage(messages.retryTooltip),
            busy: isValidating,
          }}
        />
      )}
      {current?.pageInfo.results === 0 ? (
        <PageErrorMessage
          severity="empty"
          title={intl.formatMessage(
            current.inLibrary ? messages.noChapters : messages.notInLibrary
          )}
          description={intl.formatMessage(
            current.inLibrary
              ? messages.noChaptersDescription
              : messages.notInLibraryDescription
          )}
        />
      ) : (
        (data || !error) && (
          <>
            {(current || !error) && (
              <Table className="media-chapter-table">
                <thead>
                  <tr>
                    <Table.TH className="media-chapter-number-column">
                      {intl.formatMessage(messages.chapter)}
                    </Table.TH>
                    <Table.TH>{intl.formatMessage(messages.name)}</Table.TH>
                    <Table.TH className="media-chapter-date-column">
                      {intl.formatMessage(messages.uploaded)}
                    </Table.TH>
                    <Table.TH className="media-chapter-status-column">
                      {intl.formatMessage(globalMessages.status)}
                    </Table.TH>
                    <Table.TH className="media-chapter-actions-column" />
                  </tr>
                </thead>
                <Table.TBody>
                  {!current ? (
                    <tr>
                      <Table.TD colSpan={5}>
                        <SmallLoadingSpinner />
                      </Table.TD>
                    </tr>
                  ) : (
                    current.results.map((chapter, index) => {
                      const status = chapterStatuses[chapter.status];
                      // Rows carry no stable id; the position is the row.
                      const rowKey = `${page}-${index}`;

                      return (
                        <tr key={rowKey}>
                          <Table.TD>{chapterLabel(chapter)}</Table.TD>
                          <Table.TD>{chapter.name || MISSING_VALUE}</Table.TD>
                          <Table.TD>
                            {uploadedLabel(chapter.uploadedAt)}
                          </Table.TD>
                          <Table.TD>
                            <AvailabilityValue tone={status.tone}>
                              {intl.formatMessage(status.message)}
                            </AvailabilityValue>
                          </Table.TD>
                          <Table.TD alignText="right">
                            {chapter.download && (
                              <Button
                                as="a"
                                href={`/api/v1/request/status/${encodeApiPathSegment(chapter.download.requestId)}/downloads/${encodeApiPathSegment(chapter.download.assetId)}`}
                                download
                                buttonType="primary"
                                buttonSize="standard"
                                iconOnly
                                aria-label={intl.formatMessage(
                                  messages.downloadChapter,
                                  {
                                    chapter:
                                      chapter.number === null && chapter.name
                                        ? chapter.name
                                        : chapterLabel(chapter),
                                  }
                                )}
                                title={intl.formatMessage(
                                  messages.downloadHelp
                                )}
                              >
                                <ArrowDownTrayIcon aria-hidden="true" />
                              </Button>
                            )}
                          </Table.TD>
                        </tr>
                      );
                    })
                  )}
                </Table.TBody>
              </Table>
            )}
            <PaginationFooter
              defaultPageSize={DEFAULT_PAGE_SIZE}
              page={page}
              pageSize={pageSize}
              totalPages={pages}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </>
        )
      )}
    </section>
  );
};

export default MangaChapterList;
