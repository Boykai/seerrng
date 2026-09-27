import { IssueStatus } from '@server/constants/issue';
import type Issue from '@server/entity/Issue';
import type * as FormikModule from 'formik';
import type { FormikConfig } from 'formik';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IssueDiscussion from './IssueDiscussion';

const state = vi.hoisted(() => ({
  draft: '',
  manage: true,
  userId: 1,
  post: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('formik', async (importOriginal) => {
  const actual = await importOriginal<typeof FormikModule>();
  return {
    ...actual,
    Formik: (props: FormikConfig<{ message: string }>) => (
      <actual.Formik {...props} initialValues={{ message: state.draft }} />
    ),
  };
});
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.toast }),
}));
vi.mock('@app/hooks/useUser', () => ({
  Permission: { MANAGE_ISSUES: 1 },
  useUser: () => ({
    user: { id: state.userId },
    hasPermission: () => state.manage,
  }),
}));
vi.mock('@app/components/IssueDetails/IssueComment', () => ({
  default: ({ comment }: { comment: { message: string } }) => (
    <p>{comment.message}</p>
  ),
}));

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const fixture = (status = IssueStatus.OPEN) =>
  ({
    id: 7,
    status,
    createdAt: '2026-09-21T12:00:00Z',
    createdBy: { id: 1 },
    comments: [
      { id: 1, message: 'Original description' },
      { id: 2, message: 'Existing comment', user: { id: 1 } },
    ],
  }) as unknown as Issue;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/movie/123',
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.post.mockReset();
  state.post.mockResolvedValue({});
  state.update.mockResolvedValue(undefined);
  state.manage = true;
  state.draft = '';
  state.userId = 1;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});
const render = async (issue = fixture()) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <IssueDiscussion issue={issue} onUpdate={state.update} />
      </IntlProvider>
    )
  );
};
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === label
  )!;

it('shows description, existing comments and a blank comment field without repeating the description as a comment', async () => {
  await render();
  expect(container.textContent?.match(/Original description/g)).toHaveLength(1);
  expect(container.textContent).toContain('Existing comment');
  expect(container.querySelector('textarea')).not.toBeNull();
  expect(button('Add Comment').disabled).toBe(true);
  expect(button('Close Issue').className).toContain('app-button-warning');
});
it('closes one open issue and refreshes in place', async () => {
  await render();
  await act(async () => button('Close Issue').click());
  expect(state.post).toHaveBeenCalledWith('/api/v1/issue/7/resolved');
  expect(state.update).toHaveBeenCalledOnce();
  expect(window.location.pathname).toBe('/movie/123');
});
it('reopens a closed issue and refreshes in place', async () => {
  await render(fixture(IssueStatus.RESOLVED));
  expect(button('Reopen Issue').className).toContain('app-button-success');
  await act(async () => button('Reopen Issue').click());
  expect(state.post).toHaveBeenCalledWith('/api/v1/issue/7/open');
  expect(state.update).toHaveBeenCalledOnce();
});
it('keeps controls usable and reports a failed status update', async () => {
  state.post.mockRejectedValueOnce(new Error('fixture failure'));
  await render();
  await act(async () => button('Close Issue').click());
  expect(state.update).not.toHaveBeenCalled();
  expect(button('Close Issue').disabled).toBe(false);
  expect(state.toast).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ appearance: 'error' })
  );
});
it('allows the creator to act but keeps another viewer read-only', async () => {
  state.manage = false;
  await render();
  expect(button('Close Issue')).toBeDefined();
  state.userId = 2;
  await render();
  expect(container.querySelector('textarea')).toBeNull();
  expect(button('Close Issue')).toBeUndefined();
  expect(container.textContent).toContain('Existing comment');
});
it('blocks an empty comment even when the form is submitted directly', async () => {
  await render();
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
      )
  );
  expect(state.post).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Enter a comment before adding it.');
});

it('adds a trimmed valid comment and refreshes after success', async () => {
  state.draft = '  New comment  ';
  await render();
  await act(async () => button('Add Comment').click());
  expect(state.post).toHaveBeenCalledWith('/api/v1/issue/7/comment', {
    message: 'New comment',
  });
  expect(state.update).toHaveBeenCalledOnce();
});

it('keeps the draft when adding a comment fails', async () => {
  state.draft = 'Keep this draft';
  state.post.mockRejectedValueOnce(new Error('fixture failure'));
  await render();
  await act(async () => button('Add Comment').click());
  expect(state.update).not.toHaveBeenCalled();
  expect(container.querySelector('textarea')?.value).toBe('Keep this draft');
  expect(state.toast).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ appearance: 'error' })
  );
});
