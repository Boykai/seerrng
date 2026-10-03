import Badge from '@app/components/Common/Badge';
import { MatchedBy } from '@app/components/Settings/MangaLibrary';
import { messages as libraryMessages } from '@app/components/Settings/MangaLibrary/messages';
import {
  getFailureMessage,
  getReasonMessage,
  getStatusLabel,
  messages,
} from '@app/components/Settings/MangaSources/messages';
import type { MangaLibraryBinding } from '@server/interfaces/api/mangaLibraryInterfaces';
import type { MangaResolveTitle } from '@server/interfaces/api/mangaResolveInterfaces';
import { useIntl } from 'react-intl';

type Match = Pick<MangaLibraryBinding, 'matchedBy' | 'confidence'>;

/** The status badge, plus "Search Queued" while a search waits. */
export const StatusBadges = ({ title }: { title: MangaResolveTitle }) => {
  const intl = useIntl();
  const label = getStatusLabel(title.status);

  return (
    <div className="settings-manga-sources-badges">
      {label && (
        <Badge badgeType={label.badgeType}>
          {intl.formatMessage(label.message)}
        </Badge>
      )}
      {title.searchRequestedAt && (
        <Badge badgeType="primary">
          {intl.formatMessage(messages.searchQueued)}
        </Badge>
      )}
    </div>
  );
};

/**
 * One fixed message per reason. An exact link credits MangaDex through the
 * match that carries it; the list has none, as BOUND titles leave it.
 */
export const StatusReason = ({
  title,
  matches = [],
}: {
  title: MangaResolveTitle;
  matches?: Match[];
}) => {
  const intl = useIntl();
  const reason: string | null = title.reason;

  if (reason === 'EXACT_LINK') {
    const exact = matches.find((match) => match.matchedBy === 'mangadex-link');
    return exact ? <MatchedBy binding={exact} /> : null;
  }
  if (reason === 'ADMIN_BIND') {
    return <span>{intl.formatMessage(libraryMessages.chosenByAdmin)}</span>;
  }

  const message = getReasonMessage(reason);
  return message ? <span>{intl.formatMessage(message)}</span> : null;
};

/** What went wrong in the last run, as a fixed message. */
export const StatusFailure = ({ title }: { title: MangaResolveTitle }) => {
  const intl = useIntl();
  const message = getFailureMessage(title.lastError);

  return message ? <span>{intl.formatMessage(message)}</span> : null;
};

export const CheckDate = ({ value }: { value: string | null }) => {
  const intl = useIntl();

  return value ? (
    <time dateTime={value}>
      {intl.formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  ) : null;
};
