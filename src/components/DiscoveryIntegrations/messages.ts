import defineMessages from '@app/utils/defineMessages';
export default defineMessages('discovery', {
  'accounts.title': 'Discovery Accounts',
  'accounts.description':
    'Connect personal accounts for recommendations and lists. These connections do not grant access to sign in to SeerrNG.',
  'accounts.failed':
    'The account operation failed. Check the provider connection and try again.',
  'accounts.expired':
    'Authorization expired or was declined. Start a new connection.',
  'accounts.disconnected': 'Not connected',
  'accounts.unconfigured': 'Administrator setup required',
  'accounts.disconnect': 'Disconnect',
  'accounts.connect': 'Connect',
  'accounts.authorize': 'Authorize SeerrNG on {provider}.',
  'accounts.open': 'Open authorization page',
  'accounts.code': 'Authorization code',
  'accounts.complete': 'Complete connection',
  'accounts.cancel': 'Cancel',
  'configuration.title': 'Discovery Integrations',
  'configuration.description':
    'Configure provider applications here. Users connect their own accounts under Linked Accounts. Saved secrets are hidden; leave a field unchanged to retain its value.',
  'configuration.failed':
    'Integration settings could not be saved or loaded. Try again.',
  'configuration.saved': 'Integration settings saved.',
  'configuration.configured': 'Configured',
  'configuration.unconfigured': 'Not configured',
  'configuration.clientid': 'Client ID',
  'configuration.clientsecret': 'Client secret',
  'configuration.apikey': 'API key',
  'configuration.clear': 'Clear this integration',
  'configuration.save': 'Save integration settings',
  'providers.title': 'Provider Discovery',
  'providers.description':
    'Browse personal recommendations, anime catalogs, and curated lists.',
  'providers.manage': 'Manage connected accounts',
  'providers.feed': 'Discovery feed',
  'providers.list': 'MDBList URL or list ID',
  'providers.browse': 'Browse list',
  'providers.failed':
    'This feed could not be loaded. Check your connected account or provider configuration.',
  'providers.retry': 'Retry',
  'providers.loading': 'Loading discovery feed…',
  'providers.empty': 'No titles on this page.',
  'providers.unmapped':
    'Some titles do not have a confirmed catalog match yet. They are shown with their original provider information.',
  'providers.matchpending': 'Catalog match pending',
  'providers.previous': 'Previous',
  'providers.page': 'Page {page}',
  'providers.next': 'Next',
  'providers.explore': 'Explore provider recommendations and lists',
});
