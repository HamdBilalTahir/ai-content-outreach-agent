/**
 * The one adapter between a Web-standard `Request`/`Response` and the framework-free view shapes.
 *
 * Written against the WHATWG classes rather than `NextRequest`/`NextResponse` deliberately: those are
 * subclasses, so a Next.js route can pass its own objects straight in, and the module stays testable
 * with a plain `new Request(...)`. Nothing here imports from `next`.
 *
 * ## Body parsing mirrors DRF's default parsers, with one deliberate difference
 *
 * DRF installs `JSONParser`, `FormParser`, and `MultiPartParser`, and raises `UnsupportedMediaType`
 * (→ 415) for anything else with a non-empty body. This port instead **tries JSON as a last resort and
 * falls back to `{}`**. Two reasons, both about providers:
 *
 *  - Senders omit or misdeclare `Content-Type` routinely, and a JSON body labelled `text/plain` is
 *    still the payload we want. Guessing right costs nothing; guessing wrong yields `{}`.
 *  - A 415 returned to a webhook is retried. Retrying a body that will never parse is a loop, not a
 *    recovery — and every view in the table already handles a field it cannot find.
 *
 * The multipart case is not hypothetical: SendGrid Inbound Parse posts the inbound email webhook as
 * `multipart/form-data`, so the email route would see nothing at all without it.
 */

import type { HttpMethod, OutboundRequest, OutboundResponse } from './types';

/** Flatten a query string LAST-wins — see the note on `OutboundRequest.query`. */
function flattenQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const search = new URL(url, 'http://localhost').searchParams;
  for (const [k, v] of search.entries()) out[k] = v;
  return out;
}

function flattenForm(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    // File parts are dropped: nothing in the outbound surface reads an upload, and keeping a `File`
    // in `body` would make the shape depend on the runtime's FormData implementation.
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

interface ParsedBody {
  body: Record<string, unknown>;
  bodyArray: unknown[] | null;
  rawBody: string;
}

async function parseBody(
  request: Request,
  contentType: string
): Promise<ParsedBody> {
  const empty: ParsedBody = { body: {}, bodyArray: null, rawBody: '' };
  if (request.method === 'GET' || request.method === 'HEAD') return empty;

  const type = contentType.split(';')[0].trim().toLowerCase();

  // Form bodies must be read through `formData()` — a multipart body has no useful string form, and
  // reading it as text would consume the stream and leave nothing to parse.
  if (
    type === 'multipart/form-data' ||
    type === 'application/x-www-form-urlencoded'
  ) {
    try {
      const form = await request.formData();
      return { body: flattenForm(form), bodyArray: null, rawBody: '' };
    } catch (e) {
      console.warn(`[OB_HTTP] form body parse failed: ${e}`);
      return empty;
    }
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch (e) {
    console.warn(`[OB_HTTP] body read failed: ${e}`);
    return empty;
  }
  if (!raw) return { ...empty, rawBody: '' };

  // JSON, whether or not it was declared as such. See the module note.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { body: {}, bodyArray: parsed, rawBody: raw };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        body: parsed as Record<string, unknown>,
        bodyArray: null,
        rawBody: raw,
      };
    }
  } catch {
    // Not JSON. `rawBody` still carries the bytes, which is all a signature check needs.
  }
  return { body: {}, bodyArray: null, rawBody: raw };
}

/** Build the framework-free request. Consumes the body, so call it once per `Request`. */
export async function fromWebRequest(
  request: Request,
  params: Record<string, string> = {}
): Promise<OutboundRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const { body, bodyArray, rawBody } = await parseBody(
    request,
    headers['content-type'] ?? ''
  );

  return {
    method: request.method.toUpperCase() as HttpMethod,
    params,
    query: flattenQuery(request.url),
    headers,
    body,
    bodyArray,
    rawBody,
  };
}

/** Render a view's result. `json` and `body` are mutually exclusive; `json` wins if both are set. */
export function toWebResponse(result: OutboundResponse): Response {
  const headers = new Headers(result.headers ?? {});
  if (result.json !== undefined) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(result.json), {
      status: result.status,
      headers,
    });
  }
  headers.set('content-type', result.contentType ?? 'text/plain');
  return new Response(result.body ?? '', { status: result.status, headers });
}
