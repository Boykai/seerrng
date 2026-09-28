import 'express-session';

// Declaration merging to apply our own types to SessionData
// See: (https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/express-session/index.d.ts#L23)
declare module 'express-session' {
  interface SessionData {
    userId: number;
    credentialVersion?: number;
    discoveryAuth?: Partial<
      Record<
        'trakt' | 'simkl',
        {
          code: string;
          userCode: string;
          clientId: string;
          expiresAt: number;
          interval: number;
          nextPollAt: number;
        }
      >
    >;
    spotifyOAuthState?: string;
    spotifyOAuthStateCreatedAt?: number;
  }
}
