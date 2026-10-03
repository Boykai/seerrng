import {
  isAvailableLocale,
  type AvailableLocale,
} from '@server/types/languages';
import { useEffect, useState } from 'react';

export type LocaleMessages = Record<string, string>;

export interface LoadedLocaleMessages {
  locale: AvailableLocale;
  messages: LocaleMessages;
}

// English renders from each message's defineMessages default, so it needs no
// catalogue and en.json stays out of the application bundle.
export const englishLocaleMessages: LoadedLocaleMessages = {
  locale: 'en',
  messages: {},
};

// Returns the locale and catalogue to render. A locale switch keeps the last
// fully loaded locale until the selected catalogue arrives, so text and
// formatting never mix two locales. An unknown locale renders English.
const useLocaleMessages = (
  selectedLocale: string,
  loadLocaleMessages: (locale: AvailableLocale) => Promise<LocaleMessages>
): LoadedLocaleMessages => {
  const [loaded, setLoaded] = useState<LoadedLocaleMessages>(
    englishLocaleMessages
  );

  useEffect(() => {
    if (selectedLocale === 'en' || !isAvailableLocale(selectedLocale)) {
      setLoaded(englishLocaleMessages);
      return;
    }

    const locale = selectedLocale;
    let active = true;
    void loadLocaleMessages(locale)
      .then((messages) => {
        if (active) {
          setLoaded({ locale, messages });
        }
      })
      .catch(() => {
        // Keep the last complete locale when a catalogue fails to load.
      });

    return () => {
      active = false;
    };
  }, [selectedLocale, loadLocaleMessages]);

  return loaded;
};

export default useLocaleMessages;
