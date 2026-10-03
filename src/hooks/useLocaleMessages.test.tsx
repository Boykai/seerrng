import { englishLocaleMessages } from '@app/hooks/useLocaleMessages';
import defineMessages from '@app/utils/defineMessages';
import type { AvailableLocale } from '@server/types/languages';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider, useIntl } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useLocaleMessages, { type LocaleMessages } from './useLocaleMessages';

const messages = defineMessages('hooks.useLocaleMessages.test', {
  greeting: 'Requested {count, plural, one {# chapter} other {# chapters}}',
});

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;
let loader: ReturnType<
  typeof vi.fn<(locale: AvailableLocale) => Promise<LocaleMessages>>
>;
let pending: Map<
  AvailableLocale,
  { resolve: (value: LocaleMessages) => void; reject: (e: Error) => void }
>;
let errors: unknown[];

const Greeting = () => {
  const intl = useIntl();
  return (
    <p data-locale={intl.locale}>
      {intl.formatMessage(messages.greeting, { count: 2 })}
    </p>
  );
};

const App = ({ selected }: { selected: string }) => {
  const loaded = useLocaleMessages(selected, loader);
  return (
    <IntlProvider
      locale={loaded.locale}
      defaultLocale="en"
      messages={loaded.messages}
      onError={(error) => errors.push(error)}
    >
      <Greeting />
    </IntlProvider>
  );
};

const render = async (selected: string) => {
  await act(async () => root.render(<App selected={selected} />));
};

const rendered = () => {
  const paragraph = host.querySelector('p');
  return {
    locale: paragraph?.getAttribute('data-locale'),
    text: paragraph?.textContent,
  };
};

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  errors = [];
  pending = new Map();
  loader = vi.fn(
    (locale: AvailableLocale): Promise<LocaleMessages> =>
      new Promise<LocaleMessages>((resolve, reject) => {
        pending.set(locale, { resolve, reject });
      })
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

it('renders English from the message defaults with an empty catalogue', async () => {
  await render('en');

  expect(englishLocaleMessages.messages).toEqual({});
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });
  expect(loader).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
});

it('keeps the previous locale and catalogue until the selected catalogue loads', async () => {
  await render('en');
  await render('fr');

  expect(loader).toHaveBeenCalledWith('fr');
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });

  await act(async () =>
    pending.get('fr')!.resolve({
      'hooks.useLocaleMessages.test.greeting':
        '{count, plural, one {# chapitre demandé} other {# chapitres demandés}}',
    })
  );
  expect(rendered()).toEqual({
    locale: 'fr',
    text: '2 chapitres demandés',
  });

  await render('en');
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });
  expect(errors).toEqual([]);
});

it('ignores a superseded load and keeps the last complete locale on failure', async () => {
  await render('fr');
  await render('de');
  await act(async () =>
    pending.get('fr')!.resolve({
      'hooks.useLocaleMessages.test.greeting': 'superseded',
    })
  );
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });

  await act(async () => pending.get('de')!.reject(new Error('chunk failed')));
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });
  expect(errors).toEqual([]);
});

it('renders English for a locale the application does not ship', async () => {
  await render('not a locale');
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });
  expect(loader).not.toHaveBeenCalled();

  await render('fr');
  await act(async () =>
    pending.get('fr')!.resolve({
      'hooks.useLocaleMessages.test.greeting':
        '{count, plural, one {# chapitre demandé} other {# chapitres demandés}}',
    })
  );
  expect(rendered().locale).toBe('fr');

  await render('xx');
  expect(rendered()).toEqual({ locale: 'en', text: 'Requested 2 chapters' });
  expect(loader).toHaveBeenCalledTimes(1);
  expect(errors).toEqual([]);
});
