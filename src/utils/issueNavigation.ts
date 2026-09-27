export const getIssueListHref = (
  id: string | number | string[] | undefined
) => {
  const value = typeof id === 'number' ? String(id) : id;
  return typeof value === 'string' &&
    /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? `/issues?issue=${value}`
    : '/issues';
};
