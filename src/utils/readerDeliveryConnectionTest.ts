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
