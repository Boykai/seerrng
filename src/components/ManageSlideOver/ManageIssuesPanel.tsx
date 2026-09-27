import IssueItem from '@app/components/IssueList/IssueItem';
import type Issue from '@server/entity/Issue';
import { useEffect, useRef } from 'react';

export const getIssueViewportHeight = (heights: number[], gap: number) =>
  heights.slice(0, 3).reduce((sum, height) => sum + height, 0) +
  Math.max(0, Math.min(3, heights.length) - 1) * gap;

const ManageIssuesPanel = ({
  issues,
  id,
  label,
  onUpdate,
}: {
  issues: Issue[];
  id: string;
  label: string;
  onUpdate?: () => void;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const heights = Array.from(list.children)
        .slice(0, 3)
        .map((child) => child.getBoundingClientRect().height);
      const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
      list.parentElement?.style.setProperty(
        '--manage-issues-visible-height',
        `${getIssueViewportHeight(heights, gap)}px`
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    Array.from(list.children)
      .slice(0, 3)
      .forEach((child) => observer.observe(child));
    measure();
    return () => observer.disconnect();
  }, [issues]);
  return (
    <div
      id={id}
      className="app-card-inset refreshed-inset-surface manage-issues-panel"
    >
      <div
        className="manage-issues-scroll"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <div ref={listRef} className="manage-issues-list">
          {issues.map((issue) => (
            <div key={issue.id}>
              <IssueItem issue={issue} embedded onUpdate={onUpdate} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ManageIssuesPanel;
