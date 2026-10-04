export const seriesDisclosureRoles = [
  'cast',
  'crew',
  'subjectTags',
  'details',
  'mediaServer',
  'overview',
] as const;
export type SeriesDisclosureRole = (typeof seriesDisclosureRoles)[number];
export type DetailDisclosureOrder = Partial<
  Record<'tv', SeriesDisclosureRole[]>
>;

export const normalizeSeriesDisclosureOrder = (
  value: unknown
): SeriesDisclosureRole[] => {
  const known = new Set<string>(seriesDisclosureRoles);
  const supplied = Array.isArray(value)
    ? value.filter(
        (role): role is SeriesDisclosureRole =>
          typeof role === 'string' && known.has(role)
      )
    : [];
  // A newly introduced Overview starts left; once explicitly ordered, retain
  // the user's placement along with every existing role's relative order.
  if (!supplied.includes('overview')) supplied.unshift('overview');
  return [...new Set([...supplied, ...seriesDisclosureRoles])];
};

export const parseSeriesDisclosureOrder = (
  value: unknown
): SeriesDisclosureRole[] | null => {
  if (
    !Array.isArray(value) ||
    value.length > seriesDisclosureRoles.length ||
    value.some(
      (role) =>
        typeof role !== 'string' ||
        !seriesDisclosureRoles.includes(role as SeriesDisclosureRole)
    ) ||
    new Set(value).size !== value.length
  )
    return null;
  return normalizeSeriesDisclosureOrder(value);
};

export const insertDisclosureRole = (
  order: readonly SeriesDisclosureRole[],
  role: SeriesDisclosureRole,
  target: SeriesDisclosureRole,
  after: boolean
): SeriesDisclosureRole[] => {
  if (role === target) return [...order];
  const next = order.filter((item) => item !== role);
  const index = next.indexOf(target);
  if (index < 0) return [...order];
  next.splice(index + Number(after), 0, role);
  return next;
};
