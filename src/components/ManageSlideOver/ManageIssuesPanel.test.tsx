import type Issue from '@server/entity/Issue';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ManageIssuesPanel, { getIssueViewportHeight } from './ManageIssuesPanel';

vi.mock('@app/components/IssueList/IssueItem', () => ({
  default: ({ issue }: { issue: Issue }) => (
    <article>
      Issue {issue.id}: {issue.status}
    </article>
  ),
}));
beforeEach(() => vi.stubGlobal('React', React));

it('caps the measured viewport at three cards including shared gaps', () => {
  expect(getIssueViewportHeight([], 8)).toBe(0);
  expect(getIssueViewportHeight([100], 8)).toBe(100);
  expect(getIssueViewportHeight([100, 120], 8)).toBe(228);
  expect(getIssueViewportHeight([100, 120, 140, 200], 8)).toBe(376);
});

it('keeps every open and resolved issue in the scrollable list', () => {
  const issues = [
    { id: 1, status: 1 },
    { id: 2, status: 2 },
    { id: 3, status: 1 },
    { id: 4, status: 2 },
  ] as Issue[];
  const html = renderToStaticMarkup(
    <ManageIssuesPanel
      issues={issues}
      id="all-issues"
      label="View All Issues"
    />
  );
  expect(html.match(/<article>/g)).toHaveLength(4);
  expect(html).toContain('role="region"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('manage-issues-scroll');
});
