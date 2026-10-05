import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import ReaderDeliveryLink from './ReaderDeliveryLink';

const mockState = vi.hoisted(() => ({
  response: undefined as unknown,
}));

vi.mock('swr', () => ({
  default: () => ({ data: mockState.response }),
}));

vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content?: React.ReactNode;
  }) => <span title={content as string}>{children}</span>,
}));

const renderLink = (target: 'ebooks' | 'audiobooks' | 'comics' | 'magazines') =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <ReaderDeliveryLink target={target} />
    </IntlProvider>
  );

beforeEach(() => {
  mockState.response = {
    provider: 'grimmory',
    serviceName: 'Grimmory',
    serviceUrl: 'https://grimmory.example/library',
    grimmoryUrl: 'https://grimmory.example/library',
  };
});

it('opens the Grimmory library for comics and points to its Komga address in settings', () => {
  const html = renderLink('comics');

  expect(html).toContain('Browse comics in Grimmory');
  expect(html).toContain('href="https://grimmory.example/library"');
  expect(html).toContain('copy Grimmory’s Komga address under Settings');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('noopener noreferrer');
});

it('opens BookOrbit library for magazine PDF browsing', () => {
  mockState.response = {
    provider: 'bookorbit',
    serviceName: 'BookOrbit',
    serviceUrl: 'https://bookorbit.example/base',
    grimmoryUrl: null,
  };

  const html = renderLink('magazines');

  expect(html).toContain('Browse magazine PDFs in BookOrbit');
  expect(html).toContain('href="https://bookorbit.example/base"');
});

it('opens the reader app base when an older setting contains the OPDS endpoint', () => {
  mockState.response = {
    provider: 'grimmory',
    serviceName: 'Grimmory',
    serviceUrl: 'https://grimmory.example/library/api/v1/opds',
    grimmoryUrl: 'https://grimmory.example/library/api/v1/opds',
  };

  const html = renderLink('ebooks');

  expect(html).toContain('href="https://grimmory.example/library"');
});

it('guides BookOrbit comic users to its built-in reader when Grimmory is not set up', () => {
  mockState.response = {
    provider: 'bookorbit',
    serviceName: 'BookOrbit',
    serviceUrl: 'https://bookorbit.example',
    grimmoryUrl: null,
  };

  const html = renderLink('comics');

  expect(html).toContain('href="https://bookorbit.example"');
  expect(html).toContain('built-in comic reader');
  expect(html).toContain('Grimmory Komga supports page-by-page streaming');
});

it('uses the resolved service for audiobooks, including BookOrbit when Grimmory is not configured', () => {
  expect(renderLink('audiobooks')).toContain(
    'href="https://grimmory.example/library"'
  );

  mockState.response = {
    provider: 'bookorbit',
    serviceName: 'BookOrbit',
    serviceUrl: 'https://bookorbit.example',
    grimmoryUrl: null,
  };
  const html = renderLink('audiobooks');
  expect(html).toContain('Open audiobooks in BookOrbit');
  expect(html).toContain('href="https://bookorbit.example"');
  expect(html).toContain('M4B, MP3, M4A, OPUS, OGG, and FLAC');
});

it('respects a configured BookOrbit preference for audiobooks and comics', () => {
  mockState.response = {
    provider: 'bookorbit',
    serviceName: 'BookOrbit',
    serviceUrl: 'https://bookorbit.example',
    grimmoryUrl: 'https://grimmory.example',
  };

  expect(renderLink('audiobooks')).toContain(
    'href="https://bookorbit.example"'
  );
  expect(renderLink('comics')).toContain('href="https://bookorbit.example"');
});
