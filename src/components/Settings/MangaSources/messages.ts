import {
  messages as libraryMessages,
  readErrorBody,
} from '@app/components/Settings/MangaLibrary/messages';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { MangaResolutionStatus } from '@server/entity/MangaSourceResolution';
import type {
  MangaResolveErrorCode,
  MangaResolveFailure,
  MangaResolveReason,
} from '@server/interfaces/api/mangaResolveInterfaces';
import type { IntlShape, MessageDescriptor } from 'react-intl';

export const messages = defineMessages('components.Settings.MangaSources', {
  description:
    'Requested titles that wait for a Suwayomi source. Open a title to pick a suggestion, search again or match it by hand.',
  empty: 'Titles appear here while a manga request waits for a source.',
  lastCheck: 'Last Check',
  nextCheck: 'Next Check',
  searchNow: 'Search Now',
  searchQueued: 'Search Queued',
  chooseSource: 'Choose Source',
  awaitingApproval: 'Awaiting Approval',
  queued: 'Queued',
  needsPick: 'Needs Pick',
  noMatch: 'No Match',
  excluded: 'Excluded',
  bound: 'Bound',
  existingBinding: 'The title already had a library match.',
  mangadexAmbiguous: 'Several MangaDex entries list this title.',
  exactInLibrary: 'The exact match is already in the Suwayomi library.',
  exactBoundElsewhere: 'The exact match is used by another title.',
  exactRejected: 'An admin rejected the exact match.',
  exactNotPreferred: 'The exact match is not in a preferred language.',
  exactByTitle: 'Only a title search found the exact match.',
  titleMatches: 'Only title matches were found.',
  noCandidates: 'No source returned this title.',
  noEligibleSources: 'No selected source can search this title.',
  mangadexFailed: 'The MangaDex search failed.',
  contentPolicy: 'The Manga Content settings hide this title.',
  anilistNotFound: 'AniList no longer lists this title.',
  anilistFailed: 'The AniList lookup failed.',
  anilistRateLimited: 'AniList is limiting requests.',
  mangadexCooldown: 'MangaDex is limiting requests.',
  sourceSearchFailed: 'A source search failed.',
  bindFailed: 'The match could not be saved.',
  suggestions: 'Suggestions',
  searchConfirm:
    'Searching sends this title to MangaDex and to the selected sources, even though its request is not approved.',
  selectConfirm: 'Match this title to “{title}”?',
  secondBinding:
    'This title already has a library match. Confirming adds a second one.',
  bindByHand: 'Match by Hand',
  bindTip:
    '{form, select, source {Enter its Suwayomi manga ID, or choose its source and enter its URL relative to that source.} other {Enter its Suwayomi manga ID.}}',
  mangaId: 'Suwayomi Manga ID',
  url: 'Source-Relative URL',
  invalidMangaId: 'Enter a positive whole number.',
  invalidUrl:
    'Enter a URL of up to 2,048 characters without control characters.',
  invalidSource: 'Choose a source.',
  noSources:
    'No sources are selected for this Suwayomi server. Select some in the <link>Suwayomi settings</link>.',
  errorSourceNotAllowed:
    'This source is not selected in the Suwayomi settings.',
  errorItemNotFound:
    'Suwayomi does not know this manga. Search for it in Suwayomi first, then try again.',
  errorAlreadyBound:
    'This title already has a library match. The list was refreshed.',
  errorCandidateGone:
    'Suwayomi no longer has this suggestion. Search again for new suggestions.',
  errorBoundElsewhere:
    'This manga is matched to another title. Reject that match on the Manga Library page first.',
});

// Ids shared with other screens. The text is identical, so the catalogue
// gains no strings for them.
export const settingsMessages = defineMessages('components.Settings', {
  menuMangaSources: 'Manga Sources',
});
export const requestMessages = defineMessages('components.Requests', {
  refresh: 'Refresh',
});
export const detailMessages = defineMessages('components.MangaDetails', {
  viewRequest: 'View Request',
});
export const sourceMessages = defineMessages('components.Blocklist', {
  source: 'Source',
});
export const languageMessages = defineMessages(
  'components.Discover.FilterPanel',
  { language: 'Language' }
);
export const suwayomiMessages = defineMessages('components.Settings.Suwayomi', {
  unreachable: 'Suwayomi could not be reached.',
});

type ResolveStatus = `${MangaResolutionStatus}` | 'AWAITING_APPROVAL';

export interface StatusLabel {
  message: MessageDescriptor;
  badgeType: 'default' | 'warning' | 'danger' | 'dark' | 'success';
}

const statusLabels: Record<ResolveStatus, StatusLabel> = {
  AWAITING_APPROVAL: {
    message: messages.awaitingApproval,
    badgeType: 'warning',
  },
  QUEUED: { message: messages.queued, badgeType: 'default' },
  NEEDS_PICK: { message: messages.needsPick, badgeType: 'warning' },
  NO_MATCH: { message: messages.noMatch, badgeType: 'danger' },
  EXCLUDED: { message: messages.excluded, badgeType: 'dark' },
  BOUND: { message: messages.bound, badgeType: 'success' },
};

const reasonMessages: Record<
  Exclude<MangaResolveReason, 'EXACT_LINK' | 'ADMIN_BIND'>,
  MessageDescriptor
> = {
  EXISTING_BINDING: messages.existingBinding,
  MANGADEX_AMBIGUOUS: messages.mangadexAmbiguous,
  EXACT_IN_LIBRARY: messages.exactInLibrary,
  EXACT_BOUND_ELSEWHERE: messages.exactBoundElsewhere,
  EXACT_REJECTED: messages.exactRejected,
  EXACT_NOT_PREFERRED: messages.exactNotPreferred,
  EXACT_BY_TITLE: messages.exactByTitle,
  TITLE_MATCHES: messages.titleMatches,
  NO_CANDIDATES: messages.noCandidates,
  NO_ELIGIBLE_SOURCES: messages.noEligibleSources,
  MANGADEX_FAILED: messages.mangadexFailed,
  CONTENT_POLICY: messages.contentPolicy,
  ANILIST_NOT_FOUND: messages.anilistNotFound,
};

const failureMessages: Record<MangaResolveFailure, MessageDescriptor> = {
  ANILIST_FAILED: messages.anilistFailed,
  ANILIST_RATE_LIMITED: messages.anilistRateLimited,
  MANGADEX_COOLDOWN: messages.mangadexCooldown,
  MANGADEX_FAILED: messages.mangadexFailed,
  SOURCE_SEARCH_FAILED: messages.sourceSearchFailed,
  SUWAYOMI_UNAVAILABLE: suwayomiMessages.unreachable,
  BIND_FAILED: messages.bindFailed,
};

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

export const getStatusLabel = (status: string): StatusLabel | undefined =>
  hasOwn(statusLabels, status)
    ? statusLabels[status as ResolveStatus]
    : undefined;

/**
 * The fixed message for a reason, except EXACT_LINK and ADMIN_BIND, which
 * the detail shows through L7's MatchedBy credit and chosen-by-admin text.
 */
export const getReasonMessage = (
  reason: string | null
): MessageDescriptor | undefined =>
  reason !== null && hasOwn(reasonMessages, reason)
    ? reasonMessages[reason as keyof typeof reasonMessages]
    : undefined;

export const getFailureMessage = (
  failure: string | null
): MessageDescriptor | undefined =>
  failure !== null && hasOwn(failureMessages, failure)
    ? failureMessages[failure as MangaResolveFailure]
    : undefined;

interface ErrorHandling {
  message: MessageDescriptor;
  /** The same write may succeed when sent again. */
  retry?: boolean;
  /** The title changed: what the admin acted on is stale. */
  reload?: boolean;
}

const errorHandling: Record<MangaResolveErrorCode, ErrorHandling> = {
  MANGA_INVALID_REQUEST: { message: globalMessages.error },
  MANGA_SOURCE_NOT_ALLOWED: { message: messages.errorSourceNotAllowed },
  MANGA_RESOLVE_TITLE_NOT_FOUND: {
    message: libraryMessages.errorGone,
    reload: true,
  },
  MANGA_INSTANCE_NOT_FOUND: {
    message: libraryMessages.errorServer,
    reload: true,
  },
  MANGA_CANDIDATE_NOT_FOUND: {
    message: libraryMessages.errorChanged,
    reload: true,
  },
  MANGA_ITEM_NOT_FOUND: { message: messages.errorItemNotFound },
  MANGA_ALREADY_BOUND: { message: messages.errorAlreadyBound, reload: true },
  MANGA_CANDIDATE_GONE: {
    message: messages.errorCandidateGone,
    reload: true,
  },
  MANGA_ITEM_BOUND_ELSEWHERE: { message: messages.errorBoundElsewhere },
  MANGA_UNSUPPORTED_SERVER: { message: libraryMessages.errorServer },
  MANGA_INSTANCE_CHANGED: { message: libraryMessages.errorRetry, retry: true },
  MANGA_ITEM_CHANGED: { message: libraryMessages.errorChanged, reload: true },
  MANGA_UNIQUE_CONFLICT: {
    message: libraryMessages.errorChanged,
    reload: true,
  },
  MANGA_SUWAYOMI_LOOKUP_FAILED: {
    message: libraryMessages.errorLookup,
    retry: true,
  },
};

export interface ResolveError {
  text: string;
  retry: boolean;
  reload: boolean;
}

/**
 * Turns a picker API failure into text. A known code gets its fixed
 * message; an unknown code shows the server's message as plain text; a body
 * without a code (the request validator's) gets the generic error.
 */
export const describeResolveError = (
  intl: IntlShape,
  error: unknown
): ResolveError => {
  const { code, message, suwayomiCode } = readErrorBody(error);

  if (typeof code !== 'string') {
    return {
      text: intl.formatMessage(globalMessages.error),
      retry: false,
      reload: false,
    };
  }
  if (!hasOwn(errorHandling, code)) {
    return {
      text:
        typeof message === 'string' && message.trim()
          ? message
          : intl.formatMessage(globalMessages.error),
      retry: false,
      reload: false,
    };
  }

  const handling = errorHandling[code as MangaResolveErrorCode];
  const detail =
    typeof suwayomiCode === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(suwayomiCode)
      ? suwayomiCode
      : 'none';

  return {
    text: intl.formatMessage(handling.message, { code: detail }),
    retry: handling.retry ?? false,
    reload: handling.reload ?? false,
  };
};
