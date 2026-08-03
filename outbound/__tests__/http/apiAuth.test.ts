/**
 * @jest-environment node
 *
 * The API-key guard.
 *
 * The property worth protecting above all: **it fails closed, including when the key is not configured.**
 * The source is explicit that several webhooks in that codebase had their auth commented out, and an
 * "open when unconfigured" default is how that happened. An unset `INTERNAL_VALIDATION_KEY` must mean
 * "this path is unavailable", never "this path is open".
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import { authenticate, extractApiKey, requireApiKey } from '../../http/apiAuth';
import type { OutboundRequest } from '../../http/types';

const KEY = 'super-secret-internal-key';

function req(headers: Record<string, string> = {}): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query: {},
    headers,
    body: {},
    bodyArray: null,
    rawBody: '',
  };
}

beforeEach(() => {
  process.env.INTERNAL_VALIDATION_KEY = KEY;
});

afterEach(() => {
  delete process.env.INTERNAL_VALIDATION_KEY;
});

describe('extractApiKey', () => {
  it('reads X-API-Key', () => {
    expect(extractApiKey(req({ 'x-api-key': ' k1 ' }))).toBe('k1');
  });

  it('reads Authorization: Bearer, case-insensitively on the scheme', () => {
    expect(extractApiKey(req({ authorization: 'Bearer k1' }))).toBe('k1');
    expect(extractApiKey(req({ authorization: 'bearer  k1 ' }))).toBe('k1');
  });

  it('prefers X-API-Key over Authorization', () => {
    expect(
      extractApiKey(req({ 'x-api-key': 'k1', authorization: 'Bearer k2' }))
    ).toBe('k1');
  });

  it('ignores a non-Bearer Authorization scheme', () => {
    expect(extractApiKey(req({ authorization: 'Basic abc' }))).toBe('');
  });

  it('is empty with no credential at all', () => {
    expect(extractApiKey(req())).toBe('');
  });
});

describe('authenticate', () => {
  it('accepts the internal key via either header', () => {
    expect(authenticate(req({ 'x-api-key': KEY }))).toEqual({
      ok: true,
      via: 'internal',
    });
    expect(authenticate(req({ authorization: `Bearer ${KEY}` })).ok).toBe(true);
  });

  it('rejects a wrong key', () => {
    expect(authenticate(req({ 'x-api-key': 'wrong' }))).toEqual({
      ok: false,
      error: 'Invalid API key',
    });
  });

  it('rejects a key of a DIFFERENT LENGTH without throwing', () => {
    // `timingSafeEqual` throws on unequal-length buffers, so the length check has to come first —
    // otherwise a short key would 500 instead of 401.
    expect(authenticate(req({ 'x-api-key': 'x' })).ok).toBe(false);
    expect(authenticate(req({ 'x-api-key': `${KEY}extra` })).ok).toBe(false);
  });

  it('names the two accepted headers when no credential was sent', () => {
    const verdict = authenticate(req());
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('X-API-Key');
    expect(verdict.error).toContain('Authorization: Bearer');
  });

  it('FAILS CLOSED when the key is not configured at all', () => {
    // The one that matters. "Unconfigured" degrades to unavailable, never to open.
    delete process.env.INTERNAL_VALIDATION_KEY;
    expect(authenticate(req({ 'x-api-key': KEY })).ok).toBe(false);
    expect(authenticate(req({ 'x-api-key': '' })).ok).toBe(false);
    expect(authenticate(req()).ok).toBe(false);
  });

  it('reads the env at CALL time, not at module load', () => {
    process.env.INTERNAL_VALIDATION_KEY = 'rotated-key-value-here';
    expect(
      authenticate(req({ 'x-api-key': 'rotated-key-value-here' })).ok
    ).toBe(true);
  });
});

describe('requireApiKey', () => {
  it('returns null for an authorised caller', () => {
    expect(requireApiKey(req({ 'x-api-key': KEY }))).toBeNull();
  });

  it('returns a 401 with the success/error shape the cron callers read', () => {
    // Not DRF's `{detail}` — these endpoints are called by cron routes and scripts that branch on
    // `success`.
    const denied = requireApiKey(req());
    expect(denied?.status).toBe(401);
    expect(denied?.json).toMatchObject({ success: false });
  });
});
