/**
 * The framework-free request/response shapes the outbound views speak.
 *
 * The source's views are DRF `APIView` subclasses: they read `request.data`, `request.query_params`,
 * `request.headers`, and `request.body`, and return `Response(payload, status=...)`. None of that is
 * Django-specific in substance, so the port keeps the substance and drops the framework — the views
 * here are plain functions over the four things they actually read, and the Next.js route file is a
 * ~20-line adapter (see `request.ts`).
 *
 * That split is what makes the HTTP layer testable in the same suite as everything beneath it. It is
 * also how the two webhook handlers were already written in Phases 6b² and 7b²d, so the views in this
 * phase are genuinely thin over them rather than re-deriving the work.
 *
 * ## `rawBody` is carried alongside the parsed body, always
 *
 * Three endpoints verify a signature over the exact bytes received (ElevenLabs post-call and
 * conversation-init over `"{t}.{body}"`, SendGrid events over `timestamp + body`). Re-serializing the
 * parsed object would change whitespace and key order and break every one of them, so the raw string
 * travels with the request rather than being reconstructed.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OutboundRequest {
  method: HttpMethod;
  /** Path parameters captured by the route pattern, under the source's `<str:name>` names. */
  params: Record<string, string>;
  /**
   * The query string, flattened. Repeated keys resolve LAST-wins, because that is what Django's
   * `QueryDict.get` returns — `URLSearchParams.get` would hand back the first instead.
   */
  query: Record<string, string>;
  /** Header names lower-cased, as the Web `Headers` object already does. */
  headers: Record<string, string>;
  /** DRF's `request.data`: the parsed body. `{}` when absent, empty, or unparseable. */
  body: Record<string, unknown>;
  /**
   * DRF's `request.data` when the body parsed to a JSON **array**. The SendGrid event webhook posts a
   * bare array and branches on `isinstance(request.data, list)`, which an object-typed `body` cannot
   * represent. `null` whenever the body was not an array.
   */
  bodyArray: unknown[] | null;
  /** The EXACT bytes as received. See the module note — signature checks read this, never `body`. */
  rawBody: string;
}

export interface OutboundResponse {
  status: number;
  /** JSON payload. Mutually exclusive with `body`. */
  json?: unknown;
  /** A pre-rendered body (the unsubscribe pages). Mutually exclusive with `json`. */
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/** A DRF `Response(payload, status=...)`. */
export function json(payload: unknown, status = 200): OutboundResponse {
  return { status, json: payload };
}

/** A Django `HttpResponse(body, content_type=...)`. */
export function text(
  body: string,
  status = 200,
  contentType = 'text/plain'
): OutboundResponse {
  return { status, body, contentType };
}

/** One view: request in, response out. Nothing in this signature knows about a web framework. */
export type OutboundView = (
  request: OutboundRequest
) => Promise<OutboundResponse> | OutboundResponse;

/**
 * Python's `int(...)`, which is stricter than `parseInt`.
 *
 * `int("2.5")` and `int("2abc")` both raise, while `parseInt` returns `2` for each. Every source site
 * that reads an integer query param wraps it in `try/except (TypeError, ValueError)` and falls back —
 * so a malformed value must reach the fallback, not a silently truncated number.
 */
export function pyInt(
  value: string | undefined | null,
  fallback: number
): number {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  if (!/^[+-]?\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}
