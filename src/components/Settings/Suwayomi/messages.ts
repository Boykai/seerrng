import defineMessages from '@app/utils/defineMessages';
import type { SuwayomiDetectedAuthMode } from '@server/api/suwayomi/types';
import type {
  SuwayomiConnectionTestErrorCode,
  SuwayomiConnectionTestWarningCode,
  SuwayomiSettingsErrorCode,
} from '@server/interfaces/api/suwayomiInterfaces';
import type { MessageDescriptor } from 'react-intl';

export const messages = defineMessages('components.Settings.Suwayomi', {
  title: 'Suwayomi Settings',
  description:
    'Connect the Suwayomi server SeerrNG uses for manga. You can add one server.',
  addServer: 'Add Suwayomi Server',
  editServer: 'Edit Suwayomi Server',
  add: 'Add Server',
  loadFailure: 'Failed to load the Suwayomi settings.',
  name: 'Server Name',
  username: 'Username',
  password: 'Password',
  requireCbz: 'Require CBZ Downloads',
  requireCbzTip: 'The test fails unless Suwayomi saves downloads as CBZ files.',
  sources: 'Sources',
  sourcesTip:
    'SeerrNG searches only the selected sources, in the order selected.',
  runTest: 'Run a test to load the source list.',
  filterSources: 'Filter sources',
  sourceLimit: 'You can select up to {max} sources.',
  priority: 'Priority {priority}',
  safe: 'Safe',
  mixed: 'Mixed',
  nsfw: 'NSFW',
  updateAvailable: 'Update Available',
  obsolete: 'Obsolete',
  missing: 'Missing',
  languages: 'Preferred Languages',
  languagesTip: 'Comma-separated language codes, most preferred first.',
  scanlators: 'Preferred Scanlators',
  scanlatorsTip: 'One group per line, most preferred first.',
  authentication: 'Authentication',
  version: 'Version',
  authUiLogin: 'UI Login',
  authBasic: 'Basic Auth',
  authNone: 'No Authentication',
  authSimple: 'Simple Login',
  authRequired: 'Login Required',
  testSuccess: 'Suwayomi connection established successfully!',
  testFailure: 'Failed to connect to Suwayomi.',
  saveFailure: 'Failed to save the Suwayomi server.',
  tooLong: 'Enter at most {max} characters.',
  lineBreak: 'Line breaks are not allowed.',
  invalidBaseUrl: 'Enter a relative path, such as /suwayomi.',
  invalidLanguages: 'Enter up to {max} codes of letters, digits, - or _.',
  invalidScanlators: 'Enter up to {max} names of {length} characters or fewer.',
  invalidSettings: 'A setting is invalid. Check the values and try again.',
  passwordRequired:
    'Enter the password again: the server address or username changed.',
  instanceLimit: 'Only one Suwayomi server can be configured.',
  inUse: 'Suwayomi is used by active manga requests and cannot be deleted.',
  credentialsRequired:
    'Suwayomi requires a login. Enter its username and password.',
  unreachable: 'Suwayomi could not be reached.',
  timeout: 'The Suwayomi connection test did not finish in time.',
  notSuwayomi: 'The address did not answer like a Suwayomi server.',
  authFailed: 'Suwayomi rejected the username or password.',
  simpleLogin:
    'Suwayomi uses simple login, which SeerrNG does not support. Switch Suwayomi to UI login.',
  unsupported:
    'This Suwayomi server lacks features SeerrNG needs. Update Suwayomi to v2.3.2223 or later.',
  noSources: 'Suwayomi has no sources installed besides the local source.',
  cbzRequired:
    'Suwayomi does not save downloads as CBZ files. Enable CBZ downloads in Suwayomi or turn off Require CBZ Downloads.',
  upstreamError: 'Suwayomi reported an error during the test.',
  warnAuthDisabled:
    "Authentication is disabled on this Suwayomi server. You can enable it in Suwayomi's settings.",
  warnBasicAuth: 'Suwayomi uses basic authentication. UI login is recommended.',
  warnEmptyCredentials:
    "The configured username or password is empty. Check Suwayomi's authentication settings.",
  warnCbzDisabled:
    'Suwayomi does not save downloads as CBZ files. CBZ downloads are recommended.',
  warnQueueErrors:
    '{count, plural, one {# download} other {# downloads}} in the Suwayomi queue failed.',
  warnOldRevision:
    'This Suwayomi release is older than the one SeerrNG is tested with.',
  warnUnknownVersion: 'SeerrNG could not read the Suwayomi version.',
  warnNoIntrospection:
    'Suwayomi refused the schema check, so SeerrNG checked only its version.',
  warnPerUserSchema:
    'This Suwayomi version tracks downloads per user, which SeerrNG is not tested with.',
  warnSourceUpdate: 'Updates are available for: {sources}.',
  warnSourceObsolete: 'These sources are obsolete: {sources}.',
  warnSourceMissing: 'These sources are no longer installed: {sources}.',
});

// Ids shared with the other service settings. The text is identical, so the
// catalogue gains no strings for them.
export const sharedMessages = defineMessages('components.Settings', {
  address: 'Address',
  ssl: 'SSL',
  deleteServer: 'Delete {serverType} Server',
  deleteserverconfirm: 'Are you sure you want to delete this server?',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  enablessl: 'Use SSL',
  urlBase: 'URL Base',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  valueRequired: 'You must provide a value.',
});

export type SuwayomiErrorCode =
  SuwayomiSettingsErrorCode | SuwayomiConnectionTestErrorCode;

export const errorMessages: Record<SuwayomiErrorCode, MessageDescriptor> = {
  SUWAYOMI_INVALID_SETTINGS: messages.invalidSettings,
  SUWAYOMI_CREDENTIALS_REQUIRED: messages.credentialsRequired,
  SUWAYOMI_PASSWORD_REQUIRED: messages.passwordRequired,
  SUWAYOMI_INSTANCE_LIMIT: messages.instanceLimit,
  SUWAYOMI_IN_USE: messages.inUse,
  SUWAYOMI_UNREACHABLE: messages.unreachable,
  SUWAYOMI_TIMEOUT: messages.timeout,
  SUWAYOMI_NOT_SUWAYOMI: messages.notSuwayomi,
  SUWAYOMI_AUTH_FAILED: messages.authFailed,
  SUWAYOMI_SIMPLE_LOGIN_UNSUPPORTED: messages.simpleLogin,
  SUWAYOMI_UNSUPPORTED_SERVER: messages.unsupported,
  SUWAYOMI_NO_SOURCES: messages.noSources,
  SUWAYOMI_CBZ_REQUIRED: messages.cbzRequired,
  SUWAYOMI_UPSTREAM_ERROR: messages.upstreamError,
};

export const warningMessages: Record<
  SuwayomiConnectionTestWarningCode,
  MessageDescriptor
> = {
  AUTH_DISABLED: messages.warnAuthDisabled,
  BASIC_AUTH_IN_USE: messages.warnBasicAuth,
  EMPTY_CREDENTIALS: messages.warnEmptyCredentials,
  CBZ_DISABLED: messages.warnCbzDisabled,
  QUEUE_ERRORS: messages.warnQueueErrors,
  BELOW_PINNED_REVISION: messages.warnOldRevision,
  UNKNOWN_VERSION: messages.warnUnknownVersion,
  INTROSPECTION_UNAVAILABLE: messages.warnNoIntrospection,
  PER_USER_SCHEMA: messages.warnPerUserSchema,
  SOURCE_UPDATE_AVAILABLE: messages.warnSourceUpdate,
  SOURCE_OBSOLETE: messages.warnSourceObsolete,
  SOURCE_MISSING: messages.warnSourceMissing,
};

export const authModeMessages: Record<
  SuwayomiDetectedAuthMode,
  MessageDescriptor
> = {
  UI_LOGIN: messages.authUiLogin,
  BASIC_AUTH: messages.authBasic,
  NONE: messages.authNone,
  SIMPLE_LOGIN: messages.authSimple,
  LOGIN_REQUIRED: messages.authRequired,
};
