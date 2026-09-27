import IssueItem from '@app/components/IssueList/IssueItem';
import type Issue from '@server/entity/Issue';

const IssueBlock = ({ issue }: { issue: Issue }) => (
  <IssueItem issue={issue} embedded />
);

export default IssueBlock;
