import { useTheme } from '@app/context/ThemeContext';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ADVANCED_THEME_COLOR_TOKENS,
  validateAdvancedThemeOverrides,
} from '@server/utils/advancedThemeOverrides';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('pages.profile.advancedTheme', {
  title: 'Advanced Theme Overrides',
  description:
    'Edit supported visual theme tokens for your account. Your changes apply only to you; an empty object keeps the selected theme unchanged.',
  jsonLabel: 'Theme token overrides (JSON)',
  syntaxHelp:
    'Use #RGB or #RRGGBB for colors. Spotlight strength accepts 0 through 1, gradient stop accepts a percentage, and divider shadow accepts a listed value.',
  supportedTokens: 'Supported tokens',
  save: 'Save overrides',
  reset: 'Reset to selected theme',
  saved: 'Your theme overrides were saved.',
  resetDone: 'Your theme overrides were cleared.',
  invalidJson: 'Enter a valid JSON object.',
  signIn: 'Sign in to save theme overrides.',
  saveFailed: 'Could not save theme overrides.',
  empty: 'No overrides are active.',
});

const specialTokens = [
  '--theme-page-spotlight-strength',
  '--theme-page-gradient-main-stop',
  '--theme-detail-divider-shadow',
];

const AdvancedThemePage = () => {
  const intl = useIntl();
  const { user } = useUser();
  const { advancedThemeOverrides, saveAdvancedThemeOverrides } = useTheme();
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const hasEdited = useRef(false);

  useEffect(() => {
    if (!hasEdited.current) {
      setDraft(JSON.stringify(advancedThemeOverrides ?? {}, null, 2));
    }
  }, [advancedThemeOverrides]);

  const parsedDraft = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(draft || '{}');
      return validateAdvancedThemeOverrides(parsed);
    } catch {
      return { error: intl.formatMessage(messages.invalidJson) } as const;
    }
  }, [draft, intl]);

  const saveDraft = async () => {
    if (!user) {
      setFeedback(intl.formatMessage(messages.signIn));
      return;
    }
    if ('error' in parsedDraft) {
      setFeedback(parsedDraft.error);
      return;
    }

    try {
      await saveAdvancedThemeOverrides(parsedDraft.value);
      hasEdited.current = false;
      setDraft(JSON.stringify(parsedDraft.value ?? {}, null, 2));
      setFeedback(intl.formatMessage(messages.saved));
    } catch {
      setFeedback(intl.formatMessage(messages.saveFailed));
    }
  };

  const resetOverrides = async () => {
    try {
      await saveAdvancedThemeOverrides(null);
      hasEdited.current = false;
      setDraft('{}');
      setFeedback(intl.formatMessage(messages.resetDone));
    } catch {
      setFeedback(intl.formatMessage(messages.saveFailed));
    }
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <section className="rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-lg sm:p-7">
        <h1 className="text-2xl font-bold text-white">
          {intl.formatMessage(messages.title)}
        </h1>
        <p className="mt-2 text-sm text-gray-300">
          {intl.formatMessage(messages.description)}
        </p>

        <label
          className="mt-6 block text-sm font-semibold text-gray-100"
          htmlFor="advanced-theme-overrides"
        >
          {intl.formatMessage(messages.jsonLabel)}
        </label>
        <textarea
          id="advanced-theme-overrides"
          className="mt-2 min-h-80 w-full rounded-md border border-gray-600 bg-gray-950 p-3 font-mono text-sm text-gray-100 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            hasEdited.current = true;
            setDraft(event.target.value);
            setFeedback('');
          }}
          placeholder={
            '{\n  "--theme-page-bg": "#111827",\n  "--theme-control-border": "#6366f1"\n}'
          }
          aria-describedby="advanced-theme-help"
        />
        <p id="advanced-theme-help" className="mt-2 text-xs text-gray-400">
          {intl.formatMessage(messages.syntaxHelp)}
        </p>

        <details className="mt-4 text-sm text-gray-300">
          <summary className="cursor-pointer font-medium text-gray-100">
            {intl.formatMessage(messages.supportedTokens)}
          </summary>
          <ul className="mt-3 grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2">
            {[...ADVANCED_THEME_COLOR_TOKENS, ...specialTokens].map((token) => (
              <li key={token}>{token}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-gray-400">
            Divider shadow values: <code>none</code>,{' '}
            <code>0 0 4px 0 rgb(255 255 255 / 0.8)</code>,{' '}
            <code>0 0 4px 0 rgb(0 0 0 / 0.45)</code>,{' '}
            <code>0 0 8px 0 rgb(255 255 255 / 0.35)</code>, or{' '}
            <code>0 0 8px 0 rgb(0 0 0 / 0.65)</code>.
          </p>
        </details>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={'error' in parsedDraft}
            onClick={() => void saveDraft()}
          >
            {intl.formatMessage(messages.save)}
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-600 px-4 py-2 text-sm font-semibold text-gray-100 hover:bg-gray-800"
            onClick={() => void resetOverrides()}
          >
            {intl.formatMessage(messages.reset)}
          </button>
          {!advancedThemeOverrides && (
            <span className="self-center text-xs text-gray-400">
              {intl.formatMessage(messages.empty)}
            </span>
          )}
        </div>
        {feedback && (
          <p className="mt-4 text-sm text-gray-200" role="status">
            {feedback}
          </p>
        )}
      </section>
    </main>
  );
};

export default AdvancedThemePage;
