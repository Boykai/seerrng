import {
  isForeseerNativeEventV1,
  isUsableForeseerNative,
  nativeRuntimeProtocolV1,
} from '@app/context/nativeRuntimeProtocol';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Foreseer Desktop protocol v1 adapter', () => {
  it('requires v1 identity and the session, auth, and playback capabilities', () => {
    const host = {
      protocolVersion: 1,
      hostName: 'foreseer-desktop',
      hostVersion: '0.3.0',
      capabilities: [...nativeRuntimeProtocolV1.requiredCapabilities],
      send: () => true,
    };

    assert.equal(isUsableForeseerNative(host), true);
    assert.equal(
      isUsableForeseerNative({ ...host, capabilities: ['play-item'] }),
      false
    );
    assert.equal(
      isUsableForeseerNative({ ...host, protocolVersion: 2 }),
      false
    );
  });

  it('accepts only bounded v1 event envelopes with known event types', () => {
    assert.equal(
      isForeseerNativeEventV1({
        protocolVersion: 1,
        id: 'request-1',
        type: 'auth-challenge',
        challenge: 'a'.repeat(64),
      }),
      true
    );
    assert.equal(
      isForeseerNativeEventV1({
        protocolVersion: 1,
        id: 'request-1',
        type: 'unknown',
      }),
      false
    );
    assert.equal(
      isForeseerNativeEventV1({
        protocolVersion: 1,
        id: 'r'.repeat(65),
        type: 'ready',
      }),
      false
    );
  });
});
