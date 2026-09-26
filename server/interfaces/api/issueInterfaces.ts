import type { IssueSubtype, IssueType } from '@server/constants/issue';
import type Issue from '@server/entity/Issue';
import type { PaginatedResponse } from './common';
import type { SeasonEpisodeSelection } from './seasonInterfaces';

export interface IssueResultsResponse extends PaginatedResponse {
  results: Issue[];
  counts?: {
    all: number;
    open: number;
    resolved: number;
  };
  status?: number;
  message?: string;
}

export type IssueRequestBody = {
  message: string;
  mediaId: number;
  issueType: IssueType;
  issueSubtype?: IssueSubtype;
  problemSeason?: number;
  problemEpisode?: number;
  problemEpisodes?: number[];
  problemEpisodeSelections?: SeasonEpisodeSelection[];
  is4k?: boolean;
  userId?: number;
};
