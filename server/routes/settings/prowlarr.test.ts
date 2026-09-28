import { defaultProwlarrCategoryMappings } from '@server/constants/prowlarr';
import type { ProwlarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseProwlarrSettings } from './prowlarr';

const existingSettings: ProwlarrSettings = {
  hostname: 'prowlarr.local',
  port: 9696,
  useSsl: false,
  baseUrl: '',
  apiKey: 'saved-test-api-key',
  categoryMappings: defaultProwlarrCategoryMappings(),
};

it('preserves the saved Prowlarr key when a connection test omits it', () => {
  const parsed = parseProwlarrSettings(
    { hostname: 'prowlarr.local', port: 9696, useSsl: false },
    existingSettings
  );

  assert.equal('error' in parsed, false);
  if (!('value' in parsed)) return;
  assert.equal(parsed.value.apiKey, 'saved-test-api-key');
});

it('clears the saved Prowlarr key when requested', () => {
  const parsed = parseProwlarrSettings(
    {
      hostname: 'prowlarr.local',
      port: 9696,
      useSsl: false,
      clearApiKey: true,
    },
    existingSettings
  );

  assert.equal('error' in parsed, false);
  if (!('value' in parsed)) return;
  assert.equal(parsed.value.apiKey, '');
});
