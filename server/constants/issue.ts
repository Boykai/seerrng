export enum IssueType {
  VIDEO = 1,
  AUDIO = 2,
  SUBTITLES = 3,
  OTHER = 4,
}

export enum IssueStatus {
  OPEN = 1,
  RESOLVED = 2,
}

export const ISSUE_SUBTYPES_BY_MEDIA_TYPE = {
  book: [
    'missing_content',
    'wrong_edition',
    'damaged_file',
    'incorrect_metadata',
    'other',
  ],
  comic: [
    'missing_issue',
    'wrong_edition',
    'damaged_file',
    'incorrect_metadata',
    'other',
  ],
  magazine: [
    'missing_issue',
    'wrong_issue',
    'damaged_file',
    'incorrect_metadata',
    'other',
  ],
} as const;

export type IssueSubtype =
  (typeof ISSUE_SUBTYPES_BY_MEDIA_TYPE)[keyof typeof ISSUE_SUBTYPES_BY_MEDIA_TYPE][number];

export const isIssueSubtypeForMediaType = (
  mediaType: string,
  subtype: string
): subtype is IssueSubtype => {
  if (
    !Object.prototype.hasOwnProperty.call(
      ISSUE_SUBTYPES_BY_MEDIA_TYPE,
      mediaType
    )
  ) {
    return false;
  }

  return (
    ISSUE_SUBTYPES_BY_MEDIA_TYPE[
      mediaType as keyof typeof ISSUE_SUBTYPES_BY_MEDIA_TYPE
    ] as readonly string[]
  ).includes(subtype);
};

export const MAX_ISSUE_MESSAGE_LENGTH = 10_000;
export const MAX_ISSUE_COMMENTS = 200;

export const IssueTypeName = {
  [IssueType.AUDIO]: 'Audio',
  [IssueType.VIDEO]: 'Video',
  [IssueType.SUBTITLES]: 'Subtitle',
  [IssueType.OTHER]: 'Other',
};
