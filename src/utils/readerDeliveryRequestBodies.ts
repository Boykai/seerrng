import type {
  ReaderDeliveryProvider,
  ReaderDeliverySettings,
} from '@server/lib/settings';

export interface ReaderDeliveryConnectionTestBody {
  provider: ReaderDeliveryProvider;
  url: string;
  username: string;
  password: string;
}

/**
 * The connection-test body for one service's form values, saved or not. A
 * blank or redacted password asks the server to reuse the saved password,
 * which it does only while the address and username are unchanged.
 */
export const readerDeliveryConnectionTestBody = (
  provider: ReaderDeliveryProvider,
  draft: ReaderDeliverySettings
): ReaderDeliveryConnectionTestBody =>
  provider === 'grimmory'
    ? {
        provider,
        url: draft.grimmoryUrl,
        username: draft.grimmoryUsername,
        password: draft.grimmoryPassword,
      }
    : {
        provider,
        url: draft.bookorbitUrl,
        username: draft.bookorbitUsername,
        password: draft.bookorbitPassword,
      };

export interface ReaderDeliverySaveBody extends ReaderDeliverySettings {
  clearGrimmoryCredentials: boolean;
  clearBookorbitCredentials: boolean;
}

/**
 * The Save body for the whole form. A blank or redacted password keeps the
 * saved password, which the server does only while that service's address
 * and username are unchanged.
 */
export const readerDeliverySaveBody = (
  draft: ReaderDeliverySettings,
  clearCredentials: Record<ReaderDeliveryProvider, boolean>
): ReaderDeliverySaveBody => ({
  grimmoryUrl: draft.grimmoryUrl,
  grimmoryUsername: draft.grimmoryUsername,
  grimmoryPassword: draft.grimmoryPassword,
  bookorbitUrl: draft.bookorbitUrl,
  bookorbitUsername: draft.bookorbitUsername,
  bookorbitPassword: draft.bookorbitPassword,
  preferredProvider: draft.preferredProvider,
  clearGrimmoryCredentials: clearCredentials.grimmory,
  clearBookorbitCredentials: clearCredentials.bookorbit,
});
