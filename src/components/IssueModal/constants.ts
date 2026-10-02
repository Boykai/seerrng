import defineMessages from '@app/utils/defineMessages';
import { IssueType } from '@server/constants/issue';
import type { MessageDescriptor } from 'react-intl';

const messages = defineMessages('components.IssueModal', {
  issueAudio: 'Audio',
  issueVideo: 'Video',
  issueSubtitles: 'Subtitle',
  issueOther: 'Other',
  issueReasonMissingContent: 'Missing content',
  issueReasonMissingIssue: 'Missing issue',
  issueReasonWrongEdition: 'Wrong edition or variant',
  issueReasonWrongIssue: 'Wrong issue or date',
  issueReasonDamagedFile: 'Damaged or unreadable file',
  issueReasonIncorrectMetadata: 'Incorrect title or metadata',
});

interface IssueOption {
  name: MessageDescriptor;
  issueType: IssueType;
  mediaType?:
    'movie' | 'tv' | 'music' | 'book' | 'comic' | 'magazine' | 'manga';
}

export const issueOptions: IssueOption[] = [
  {
    name: messages.issueVideo,
    issueType: IssueType.VIDEO,
  },
  {
    name: messages.issueAudio,
    issueType: IssueType.AUDIO,
  },
  {
    name: messages.issueSubtitles,
    issueType: IssueType.SUBTITLES,
  },
  {
    name: messages.issueOther,
    issueType: IssueType.OTHER,
  },
];

export const getIssueOptionsForMediaType = (
  mediaType: IssueOption['mediaType']
): IssueOption[] => {
  if (mediaType === 'music') {
    return issueOptions.filter((option) =>
      [IssueType.AUDIO, IssueType.OTHER].includes(option.issueType)
    );
  }

  if (
    mediaType === 'book' ||
    mediaType === 'comic' ||
    mediaType === 'magazine' ||
    mediaType === 'manga'
  ) {
    return issueOptions.filter(
      (option) => option.issueType === IssueType.OTHER
    );
  }

  return issueOptions;
};

export interface IssueSubtypeOption {
  value: string;
  name: MessageDescriptor;
}

const issueSubtypeOptions: Record<
  NonNullable<IssueOption['mediaType']>,
  IssueSubtypeOption[]
> = {
  movie: [],
  tv: [],
  music: [],
  book: [
    { value: 'missing_content', name: messages.issueReasonMissingContent },
    { value: 'wrong_edition', name: messages.issueReasonWrongEdition },
    { value: 'damaged_file', name: messages.issueReasonDamagedFile },
    {
      value: 'incorrect_metadata',
      name: messages.issueReasonIncorrectMetadata,
    },
    { value: 'other', name: messages.issueOther },
  ],
  comic: [
    { value: 'missing_issue', name: messages.issueReasonMissingIssue },
    { value: 'wrong_edition', name: messages.issueReasonWrongEdition },
    { value: 'damaged_file', name: messages.issueReasonDamagedFile },
    {
      value: 'incorrect_metadata',
      name: messages.issueReasonIncorrectMetadata,
    },
    { value: 'other', name: messages.issueOther },
  ],
  magazine: [
    { value: 'missing_issue', name: messages.issueReasonMissingIssue },
    { value: 'wrong_issue', name: messages.issueReasonWrongIssue },
    { value: 'damaged_file', name: messages.issueReasonDamagedFile },
    {
      value: 'incorrect_metadata',
      name: messages.issueReasonIncorrectMetadata,
    },
    { value: 'other', name: messages.issueOther },
  ],
  manga: [],
};

export const getIssueSubtypeOptionsForMediaType = (
  mediaType: IssueOption['mediaType']
): IssueSubtypeOption[] => (mediaType ? issueSubtypeOptions[mediaType] : []);
