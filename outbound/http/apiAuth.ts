/**
 * API-key authentication for the service-to-service endpoints — the port of `require_api_key` from
 * `inbound_agent/services/api_auth.py`.
 *
 * Only the internal-key path is ported. The source's second credential is a per-company key resolved
 * through `inbound_agent.firebase.company_api_keys`, which is the inbound product's multi-tenant key
 * store; this port has no company registry and no outbound endpoint is company-scoped, so a company-key
 * branch here would be an unreachable lookup against a collection that does not exist.
 *
 * ## It fails CLOSED, and there is no unconfigured-means-open mode
 *
 * The source is explicit about why: several webhooks in that codebase had their auth commented out, and
 * an "open when unconfigured" default is exactly how that happened. So no credential, an unrecognised
 * one, or an unset `INTERNAL_VALIDATION_KEY` all reject.
 *
 * Note what that last one means in practice: with the env var absent, the internal path can never match
 * (there is nothing to compare against) and every call to a guarded endpoint 401s. That is the intended
 * degradation — "unavailable" rather than "everything open".
 *
 * ## Comparison is constant-time
 *
 * `timingSafeEqual` over equal-length buffers, with a length check first. A plain `===` on a secret
 * leaks its length and prefix through timing; that is a cheap property to keep and an awkward one to
 * retrofit.
 */

import { timingSafeEqual } from 'node:crypto';
import { envStr } from '../config';
import { json } from './types';
import type { OutboundRequest, OutboundResponse } from './types';

const MISSING_KEY_ERROR =
  'API key is required. Provide it in the X-API-Key header ' +
  'or as Authorization: Bearer <key>.';

/** The presented key, from `X-API-Key` or `Authorization: Bearer <key>`. */
export function extractApiKey(request: OutboundRequest): string {
  const direct = (request.headers['x-api-key'] ?? '').trim();
  if (direct) return direct;
  const auth = (request.headers.authorization ?? '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

/** Constant-time equality. A length mismatch short-circuits, which is not itself a secret. */
function secretsMatch(presented: string, expected: string): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthVerdict {
  ok: boolean;
  via?: 'internal';
  error?: string;
}

/** Authorise by API key. Never throws — the caller gets a verdict and picks the response shape. */
export function authenticate(request: OutboundRequest): AuthVerdict {
  const presented = extractApiKey(request);
  if (!presented) return { ok: false, error: MISSING_KEY_ERROR };
  // Read at call time, not module load, so a test or an env reload takes effect.
  if (secretsMatch(presented, envStr('INTERNAL_VALIDATION_KEY'))) {
    return { ok: true, via: 'internal' };
  }
  return { ok: false, error: 'Invalid API key' };
}

/**
 * The guard. Returns `null` when authorised, else the 401 to return instead.
 *
 * Shaped as `{success: false, error}` rather than DRF's `{detail}`, matching the source — the callers of
 * these endpoints are cron routes and scripts that read `success`.
 */
export function requireApiKey(
  request: OutboundRequest
): OutboundResponse | null {
  const verdict = authenticate(request);
  if (verdict.ok) return null;
  console.warn(`[api_auth] rejected ${request.method}: ${verdict.error}`);
  return json({ success: false, error: verdict.error }, 401);
}
