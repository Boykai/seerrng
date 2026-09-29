import Button from '@app/components/Common/Button';
import CuratedIdentityPackControls from '@app/components/DiscoveryIntegrations/CuratedIdentityPackControls';
import discoveryMessages from '@app/components/DiscoveryIntegrations/messages';
import axios from 'axios';
import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import useSWR from 'swr';

const providers = {
  trakt: ['clientId', 'clientSecret'],
  anilist: ['clientId', 'clientSecret'],
  simkl: ['clientId'],
  mdblist: ['apiKey'],
} as const;
export const providerNames = {
  trakt: 'Trakt',
  anilist: 'AniList',
  simkl: 'Simkl',
  mdblist: 'MDBList',
};
export type ProviderConfiguration = Record<
  keyof typeof providers,
  { clientId?: string; configured: boolean }
>;
const endpoint = '/api/v1/integrations/discovery/configuration';

export default function DiscoveryConfiguration() {
  const { data, error, mutate } = useSWR<ProviderConfiguration>(endpoint);
  const [changes, setChanges] = useState<
    Record<string, Record<string, string>>
  >({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'saved' | 'failed' | null>(null);
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await axios.put(endpoint, changes);
      setChanges({});
      await mutate();
      setMessage('saved');
    } catch {
      setMessage('failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="discovery-integrations-title">
      <h3 className="heading" id="discovery-integrations-title">
        <FormattedMessage {...discoveryMessages['configuration.title']} />
      </h3>
      <p className="description mb-6">
        <FormattedMessage {...discoveryMessages['configuration.description']} />
      </p>
      {(error || message === 'failed') && (
        <p role="alert" className="mb-4 text-red-400">
          <FormattedMessage {...discoveryMessages['configuration.failed']} />
        </p>
      )}
      {message === 'saved' && (
        <p role="status" className="mb-4 text-green-400">
          <FormattedMessage {...discoveryMessages['configuration.saved']} />
        </p>
      )}
      {Object.entries(providers).map(([provider, fields]) => (
        <fieldset
          key={provider}
          disabled={busy || !data}
          className="mb-6 rounded-lg border border-gray-700 p-4"
        >
          <legend className="px-2 text-lg font-semibold">
            {providerNames[provider as keyof typeof providers]}
          </legend>
          <p className="mb-4 text-sm text-gray-400">
            {data?.[provider as keyof typeof providers].configured ? (
              <FormattedMessage
                {...discoveryMessages['configuration.configured']}
              />
            ) : (
              <FormattedMessage
                {...discoveryMessages['configuration.unconfigured']}
              />
            )}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <label
                key={field}
                htmlFor={`${provider}-${field}`}
                className="block text-sm"
              >
                {field === 'clientId' ? (
                  <FormattedMessage
                    {...discoveryMessages['configuration.clientid']}
                  />
                ) : field === 'clientSecret' ? (
                  <FormattedMessage
                    {...discoveryMessages['configuration.clientsecret']}
                  />
                ) : (
                  <FormattedMessage
                    {...discoveryMessages['configuration.apikey']}
                  />
                )}
                <input
                  id={`${provider}-${field}`}
                  type={field === 'clientId' ? 'text' : 'password'}
                  autoComplete="off"
                  maxLength={4096}
                  className="mt-2 w-full"
                  value={
                    changes[provider]?.[field] ??
                    (field === 'clientId'
                      ? (data?.[provider as keyof typeof providers].clientId ??
                        '')
                      : '')
                  }
                  onChange={(event) => {
                    setChanges((current) => ({
                      ...current,
                      [provider]: {
                        ...current[provider],
                        [field]: event.target.value,
                      },
                    }));
                    setMessage(null);
                  }}
                />
              </label>
            ))}
          </div>
          <Button
            className="mt-4"
            buttonType="danger"
            buttonSize="sm"
            onClick={() =>
              setChanges((current) => ({
                ...current,
                [provider]: Object.fromEntries(
                  fields.map((field) => [field, ''])
                ),
              }))
            }
          >
            <FormattedMessage {...discoveryMessages['configuration.clear']} />
          </Button>
        </fieldset>
      ))}
      <Button
        buttonType="primary"
        disabled={busy || !data || !Object.keys(changes).length}
        onClick={() => void save()}
      >
        <FormattedMessage {...discoveryMessages['configuration.save']} />
      </Button>
      <CuratedIdentityPackControls />
    </section>
  );
}
