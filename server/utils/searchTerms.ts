const MAX_SEARCH_TERMS = 16;

export const getSearchTerms = (
  search: string,
  maxTerms = MAX_SEARCH_TERMS
): string[] => {
  const terms: string[] = [];
  const seen = new Set<string>();
  const matcher = /"([^"]+)"|(\S+)/g;

  for (const match of search.matchAll(matcher)) {
    const term = (match[1] ?? match[2] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();

    if (!term || term === 'and' || seen.has(term)) {
      continue;
    }

    seen.add(term);
    terms.push(term);

    if (terms.length >= Math.max(1, maxTerms)) {
      break;
    }
  }

  return terms;
};

export const toBooleanAndQuery = (search: string): string =>
  getSearchTerms(search)
    .map((term) => (term.includes(' ') ? `"${term}"` : term))
    .join(' AND ');

const quoteSearchTerm = (term: string): string =>
  `"${term.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const toFieldedBooleanAndQuery = (
  search: string,
  fields: string[]
): string =>
  getSearchTerms(search)
    .map(
      (term) =>
        `(${fields
          .map((field) => `${field}:${quoteSearchTerm(term)}`)
          .join(' OR ')})`
    )
    .join(' AND ');

const escapeLuceneTerm = (term: string): string =>
  term.replace(/(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g, '\\$1');

const getLuceneTerms = (search: string): string[] =>
  getSearchTerms(search).flatMap((term) =>
    term.split(/\s+/).map(escapeLuceneTerm).filter(Boolean)
  );

export const toMusicAlbumRefinementQuery = (
  mainSearch: string,
  albumFilter: string
): string => {
  const mainQuery = getLuceneTerms(mainSearch)
    .map((term) => `(releasegroup:${term} OR artist:${term} OR tag:${term})`)
    .join(' AND ');
  const filterQuery = getLuceneTerms(albumFilter)
    .map((term) => `releasegroup:${term}`)
    .join(' AND ');

  return [mainQuery, filterQuery].filter(Boolean).join(' AND ');
};

export const matchesAllSearchTerms = (
  values: unknown[],
  search: string
): boolean => {
  const terms = getSearchTerms(search);
  if (!terms.length) {
    return true;
  }

  const searchableText = values
    .map((value) => String(value ?? '').toLocaleLowerCase())
    .join(' ');

  return terms.every((term) => searchableText.includes(term));
};
