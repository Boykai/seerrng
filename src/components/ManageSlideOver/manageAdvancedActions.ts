import {
  encodeApiPathSegment,
  normalizeExternalTitleId,
} from '@app/utils/apiPath';
import { IssueStatus } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import axios from 'axios';

export const getManageIssueIds = (
  issues: Issue[],
  action: 'closeIssues' | 'deleteIssues'
) => [
  ...new Set(
    issues
      .filter(
        (issue) =>
          action === 'deleteIssues' || issue.status === IssueStatus.OPEN
      )
      .map((issue) => issue.id)
  ),
];

// Operate on the exact IDs shown in the confirmation, never a global issue list.
// Stop on the first failure; the caller refreshes even after partial success.
export const updateManageIssues = async (
  ids: number[],
  action: 'closeIssues' | 'deleteIssues'
) => {
  for (const id of [...new Set(ids)]) {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error('Invalid issue ID');
  }
  for (const id of [...new Set(ids)]) {
    if (action === 'closeIssues')
      await axios.post(`/api/v1/issue/${id}/resolved`);
    else await axios.delete(`/api/v1/issue/${id}`);
  }
};

export const removeManageBlocklist = (
  id: string | number,
  mediaType: MediaType
) => {
  const normalizedId =
    mediaType === MediaType.BOOK ||
    mediaType === MediaType.MUSIC ||
    mediaType === MediaType.COMIC
      ? normalizeExternalTitleId(mediaType, id)
      : id;
  if (!normalizedId) throw new Error('Missing media identifier');
  return axios.delete(
    `/api/v1/blocklist/${encodeApiPathSegment(normalizedId)}?mediaType=${mediaType}`
  );
};

export const addManageBlocklist = (
  id: string | number,
  mediaType: MediaType,
  title: string
) => {
  const external =
    mediaType === MediaType.BOOK ||
    mediaType === MediaType.MUSIC ||
    mediaType === MediaType.COMIC;
  const normalizedId = external ? normalizeExternalTitleId(mediaType, id) : id;
  if (
    !normalizedId ||
    (!external &&
      (!Number.isSafeInteger(normalizedId) || Number(normalizedId) <= 0))
  )
    throw new Error('Missing or invalid media identifier');
  return axios.post('/api/v1/blocklist', {
    ...(external ? { externalId: normalizedId } : { tmdbId: normalizedId }),
    mediaType,
    title,
  });
};
