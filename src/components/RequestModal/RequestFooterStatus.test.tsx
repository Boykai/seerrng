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
