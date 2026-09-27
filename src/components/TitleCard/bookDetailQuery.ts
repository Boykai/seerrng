interface BookDetailQueryOptions {
  canonicalId: number | string;
  preferredBookFormat?: 'ebook' | 'audiobook';
  title: string;
}

export const getTitleCardBookDetailQuery = ({
  canonicalId,
  preferredBookFormat,
  title,
}: BookDetailQueryOptions): Record<string, string> | undefined => {
  const query: Record<string, string> = {};

  if (preferredBookFormat) {
    query.format = preferredBookFormat;
  }

  if (String(canonicalId).startsWith('bookshelf:')) {
    query.lookupTitle = title;
  }

  return Object.keys(query).length ? query : undefined;
};
