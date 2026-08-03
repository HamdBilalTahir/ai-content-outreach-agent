/**
 * @jest-environment node
 *
 * The Web-Request adapter.
 *
 * Three things here are load-bearing and would fail silently if they regressed:
 *
 *  - **`rawBody` survives parsing.** Three endpoints HMAC the exact bytes; a reconstructed body breaks
 *    every one of them, and the failure looks like "the provider's signature is wrong".
 *  - **Multipart parses.** SendGrid Inbound Parse posts the email webhook as `multipart/form-data`, so
 *    without it that route sees an empty body and answers "could not parse sender" to every reply.
 *  - **A JSON array reaches `bodyArray`.** The SendGrid event webhook posts a bare array, which an
 *    object-typed `body` cannot hold.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import { fromWebRequest, toWebResponse } from '../../http/request';

describe('fromWebRequest', () => {
  it('carries the raw bytes verbatim alongside the parsed object', async () => {
    // Deliberately ugly: whitespace and key order both change under a re-serialize, and either one
    // changes the HMAC.
    const raw = '{"b":2,\n   "a": 1}';
    const req = await fromWebRequest(
      new Request('http://x/api/outbound/webhooks/sendgrid/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      })
    );
    expect(req.rawBody).toBe(raw);
    expect(req.body).toEqual({ a: 1, b: 2 });
  });

  it('puts a JSON array in bodyArray and leaves body empty', async () => {
    const req = await fromWebRequest(
      new Request('http://x/e', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[{"event":"bounce"}]',
      })
    );
    expect(req.bodyArray).toEqual([{ event: 'bounce' }]);
    expect(req.body).toEqual({});
  });

  it('parses multipart/form-data — the SendGrid inbound-parse shape', async () => {
    const form = new FormData();
    form.set('from', 'Jane <jane@acme.com>');
    form.set('subject', 'Re: demo');
    form.set('text', 'sounds good');
    const req = await fromWebRequest(
      new Request('http://x/e', { method: 'POST', body: form })
    );
    expect(req.body).toEqual({
      from: 'Jane <jane@acme.com>',
      subject: 'Re: demo',
      text: 'sounds good',
    });
  });

  it('parses urlencoded bodies', async () => {
    const req = await fromWebRequest(
      new Request('http://x/e', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'agent_id=a1&message=hi+there',
      })
    );
    expect(req.body).toEqual({ agent_id: 'a1', message: 'hi there' });
  });

  it('parses JSON even when the sender misdeclares the content type', async () => {
    // The deliberate divergence from DRF, which would 415 this. See the module note in request.ts.
    const req = await fromWebRequest(
      new Request('http://x/e', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{"conversation_id":"conv_1"}',
      })
    );
    expect(req.body).toEqual({ conversation_id: 'conv_1' });
  });

  it('yields an empty body — never throws — on a body that is not JSON at all', async () => {
    const req = await fromWebRequest(
      new Request('http://x/e', { method: 'POST', body: 'not json' })
    );
    expect(req.body).toEqual({});
    expect(req.bodyArray).toBeNull();
    // Still carried: a signature check needs the bytes whether or not they parsed.
    expect(req.rawBody).toBe('not json');
  });

  it('resolves a repeated query key LAST-wins, as Django QueryDict.get does', async () => {
    const req = await fromWebRequest(
      new Request('http://x/e?agent_id=first&agent_id=second')
    );
    // URLSearchParams.get would answer 'first' here.
    expect(req.query.agent_id).toBe('second');
  });

  it('lower-cases header names and exposes the path params', async () => {
    const req = await fromWebRequest(
      new Request('http://x/e', {
        method: 'POST',
        headers: { 'ElevenLabs-Signature': 't=1,v0=abc' },
      }),
      { campaign_id: 'camp_1' }
    );
    expect(req.headers['elevenlabs-signature']).toBe('t=1,v0=abc');
    expect(req.params).toEqual({ campaign_id: 'camp_1' });
  });

  it('does not read a body on GET', async () => {
    const req = await fromWebRequest(new Request('http://x/e?window=5'));
    expect(req.method).toBe('GET');
    expect(req.rawBody).toBe('');
    expect(req.body).toEqual({});
  });
});

describe('toWebResponse', () => {
  it('renders a JSON payload', async () => {
    const res = toWebResponse({ status: 202, json: { queued: true } });
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ queued: true });
  });

  it('renders a pre-built body with its own content type', async () => {
    const res = toWebResponse({
      status: 200,
      body: '<h2>Unsubscribe</h2>',
      contentType: 'text/html',
    });
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<h2>Unsubscribe</h2>');
  });
});
