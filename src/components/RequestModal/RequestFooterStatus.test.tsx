import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import RequestFooterStatus from './RequestFooterStatus';

beforeEach(() => vi.stubGlobal('React', React));
it('uses Automatically under the shared approval heading', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en">
      <RequestFooterStatus available={false} hasAutoApprove />
    </IntlProvider>
  );
  expect(html).toContain('Automatically');
  expect(html).not.toContain('Approved Automatically');
});

it('uses plain pending status text without making Requested an action or badge', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en">
      <RequestFooterStatus available={false} hasAutoApprove requested />
    </IntlProvider>
  );
  expect(html).toContain(
    'class="request-approval-text" data-approval-state="pending"'
  );
  expect(html).toContain('Requested');
  expect(html).not.toMatch(
    /<button|<a\b|role="button"|tabindex|request-status-control|rounded-full|h-\[|!px-|!text-/
  );
});

it.each([
  [true, 'automatic', 'Automatically'],
  [false, 'required', 'Approval Required'],
])(
  'uses shared text styling for auto-approval=%s',
  (hasAutoApprove, state, label) => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en">
        <RequestFooterStatus
          available={false}
          hasAutoApprove={hasAutoApprove}
        />
      </IntlProvider>
    );
    expect(html).toContain(
      `class="request-approval-text" data-approval-state="${state}"`
    );
    expect(html).toContain(label);
    expect(html).not.toMatch(/text-emerald|text-yellow|text-\[/);
  }
);
