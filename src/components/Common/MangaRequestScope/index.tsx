import Badge from '@app/components/Common/Badge';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MangaRequestScope } from '@server/constants/mangaRequest';
import type { MangaRequestScopeValue } from '@server/lib/mangaRequests';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';

export const mangaScopeMessages = defineMessages(
  'components.Common.MangaRequestScope',
  {
    chapters: 'Chapters',
    allChapters: 'All chapters',
    latestChapters: 'Latest {count, number}',
    chapterRange: '{start}–{end}',
    chaptersFrom: '{start} onward',
    waitingForSource: 'Waiting for a source',
    waitingForSourceHint:
      'SeerrNG is looking for a source; an administrator may need to choose one.',
  }
);

/** The chapters a manga request asks for, shown beside a "Chapters" label. */
export const formatMangaScope = (
  intl: IntlShape,
  scope?: MangaRequestScopeValue | null
): string => {
  if (scope?.scope === MangaRequestScope.LATEST_N && scope.latestCount) {
    return intl.formatMessage(mangaScopeMessages.latestChapters, {
      count: scope.latestCount,
    });
  }
  if (
    scope?.scope === MangaRequestScope.RANGE &&
    scope.rangeStart !== null &&
    scope.rangeStart !== undefined
  ) {
    const start = intl.formatNumber(scope.rangeStart);
    return scope.rangeEnd !== null && scope.rangeEnd !== undefined
      ? intl.formatMessage(mangaScopeMessages.chapterRange, {
          start,
          end: intl.formatNumber(scope.rangeEnd),
        })
      : intl.formatMessage(mangaScopeMessages.chaptersFrom, { start });
  }
  return intl.formatMessage(globalMessages.all);
};

interface MangaWaitingStatusProps {
  /** Request managers also read who unblocks the request. */
  showHint?: boolean;
}

/** Shown in place of "Approved" while a manga request awaits a source. */
export const MangaWaitingStatus = ({
  showHint = false,
}: MangaWaitingStatusProps) => {
  const intl = useIntl();

  return (
    <>
      <Badge>{intl.formatMessage(mangaScopeMessages.waitingForSource)}</Badge>
      {showHint && (
        <span className="text-xs">
          {intl.formatMessage(mangaScopeMessages.waitingForSourceHint)}
        </span>
      )}
    </>
  );
};
