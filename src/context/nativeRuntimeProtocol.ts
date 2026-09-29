export const nativeRuntimeProtocolV1 = {
  protocolVersion: 1,
  hostName: 'foreseer-desktop',
  eventName: 'foreseer:native-event',
  challengePattern: /^[a-f0-9]{64}$/,
  ticketPattern: /^[A-Za-z0-9_-]{43}$/,
  itemIdMaxLength: 128,
  requestIdMaxLength: 64,
  requiredCapabilities: ['auth-bootstrap', 'play-item', 'session-reset'],
} as const;

export const nativeHostEventTypesV1 = [
  'auth-challenge',
  'ready',
  'accepted',
  'resolving',
  'starting',
  'playing',
  'stopped',
  'finished',
  'canceled',
  'error',
  'connectivity-success',
  'save-config-success',
  'browser-cache-cleared',
  'runtime-failed',
  'runtime-recovered',
  'logs-opened',
  'setup-opened',
] as const;

export type NativeHostEventTypeV1 = (typeof nativeHostEventTypesV1)[number];

export interface ForeseerNativeCommandV1 {
  id: string;
  type: 'auth.challenge' | 'auth.complete' | 'session.clear' | 'play.item';
  ticket?: string;
  itemId?: string;
}

export interface ForeseerNativeV1 {
  readonly protocolVersion: 1;
  readonly hostName: 'foreseer-desktop';
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  send: (command: ForeseerNativeCommandV1) => boolean;
}

export interface ForeseerNativeEventV1 {
  protocolVersion: 1;
  id: string;
  type: NativeHostEventTypeV1;
  challenge?: string;
}

declare global {
  interface Window {
    foreseerNative?: ForeseerNativeV1;
  }
}

export const isNativeHostEventTypeV1 = (
  type: unknown
): type is NativeHostEventTypeV1 =>
  typeof type === 'string' &&
  (nativeHostEventTypesV1 as readonly string[]).includes(type);

export const isUsableForeseerNative = (
  host: unknown
): host is ForeseerNativeV1 => {
  if (!host || typeof host !== 'object') return false;
  const candidate = host as Partial<ForeseerNativeV1>;
  return (
    candidate.protocolVersion === nativeRuntimeProtocolV1.protocolVersion &&
    candidate.hostName === nativeRuntimeProtocolV1.hostName &&
    typeof candidate.hostVersion === 'string' &&
    candidate.hostVersion.length <= 128 &&
    typeof candidate.send === 'function' &&
    Array.isArray(candidate.capabilities) &&
    nativeRuntimeProtocolV1.requiredCapabilities.every((capability) =>
      candidate.capabilities?.includes(capability)
    )
  );
};

export const isForeseerNativeEventV1 = (
  value: unknown
): value is ForeseerNativeEventV1 => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<ForeseerNativeEventV1>;
  return (
    event.protocolVersion === nativeRuntimeProtocolV1.protocolVersion &&
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    event.id.length <= nativeRuntimeProtocolV1.requestIdMaxLength &&
    isNativeHostEventTypeV1(event.type)
  );
};
