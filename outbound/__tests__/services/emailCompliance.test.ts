/**
 * @jest-environment node
 *
 * Email compliance: the SendGrid event webhook and the unsubscribe endpoint.
 *
 * Every property here has a regulatory or reputational failure mode, which is why they get direct tests
 * rather than being inferred:
 *
 *  - **GET never unsubscribes.** Corporate mail scanners follow every link in a message, so a
 *    suppressing GET would let one link-scan unsubscribe an entire domain.
 *  - **The event webhook fails CLOSED** — the opposite of this codebase's usual default — because a
 *    forged event could silence a real prospect permanently.
 *  - **Every event closes the EMAIL channel only.** No stage change, no Lost, and `call_followup` tasks
 *    survive: a bad address says nothing about whether the person can be called.
 *  - **The chat flag is what makes suppression explicable.** Without it mail stops with no reason
 *    visible to a human anywhere.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/suppression', () => ({
  suppress: jest.fn(),
  verifyUnsubToken: jest.fn(),
}));

import { generateKeyPairSync, createSign } from 'node:crypto';

import { store } from '../../testSupport/mockFirestore';
import { suppress, verifyUnsubToken } from '../../services/suppression';
import { SEND_LOG } from '../../services/reputation';
import {
  cancelPendingEmailTouches,
  flagChatsForEmailEvent,
  handleSendgridEventWebhook,
  handleUnsubscribeGet,
  handleUnsubscribePost,
  updateSendLog,
  verifyEventSignature,
} from '../../services/emailCompliance';

const suppressMock = suppress as jest.Mock;
const verifyToken = verifyUnsubToken as jest.Mock;

const EMAIL = 'jane@corp.com';
const CHAT = 'outbound__agentA__15551230000';

/** An unsigned request, valid only when the dev escape hatch is on. */
const UNSIGNED = { signature: null, timestamp: null, rawBody: '[]' };

function seedOutboundChat(over: Record<string, unknown> = {}) {
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    stage: 'Contacted',
    email_opt_out: false,
    labels: [],
    memory: { customer_email: EMAIL, first_name: 'Jane' },
    ...over,
  });
}

function chat(): Record<string, unknown> {
  return store.get(`chats/${CHAT}`) ?? {};
}

function events(...list: Array<Record<string, unknown>>) {
  return list;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  process.env.SENDGRID_WEBHOOK_ALLOW_UNSIGNED = 'true';
  delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  suppressMock.mockResolvedValue(true);
  verifyToken.mockReturnValue(true);
  seedOutboundChat();
});

afterEach(() => {
  delete process.env.SENDGRID_WEBHOOK_ALLOW_UNSIGNED;
  delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyEventSignature', () => {
  test('with NO public key configured it REJECTS by default', () => {
    // Fails closed, unlike most gates here: a forged event could silence a prospect permanently.
    delete process.env.SENDGRID_WEBHOOK_ALLOW_UNSIGNED;
    expect(verifyEventSignature(UNSIGNED)).toBe(false);
  });

  test('the dev escape hatch is explicit and opt-in', () => {
    process.env.SENDGRID_WEBHOOK_ALLOW_UNSIGNED = 'true';
    expect(verifyEventSignature(UNSIGNED)).toBe(true);
    process.env.SENDGRID_WEBHOOK_ALLOW_UNSIGNED = 'yes'; // only "true" counts
    expect(verifyEventSignature(UNSIGNED)).toBe(false);
  });

  test('a genuine ECDSA P-256 signature over timestamp+body verifies', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');

    const rawBody = '[{"event":"bounce","email":"jane@corp.com"}]';
    const timestamp = '1785500000';
    const signer = createSign('SHA256');
    signer.update(
      Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)])
    );
    const signature = signer.sign(privateKey).toString('base64');

    expect(verifyEventSignature({ signature, timestamp, rawBody })).toBe(true);
  });

  test('a tampered body fails, and so does a swapped timestamp', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');

    const timestamp = '1785500000';
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([Buffer.from(timestamp), Buffer.from('[1]')]));
    const signature = signer.sign(privateKey).toString('base64');

    expect(verifyEventSignature({ signature, timestamp, rawBody: '[2]' })).toBe(
      false
    );
    expect(
      verifyEventSignature({
        signature,
        timestamp: '1785599999',
        rawBody: '[1]',
      })
    ).toBe(false);
  });

  test('a missing header is a rejection when a key IS configured', () => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = 'not-a-real-key';
    expect(
      verifyEventSignature({ signature: '', timestamp: '1', rawBody: '[]' })
    ).toBe(false);
    expect(
      verifyEventSignature({ signature: 'abc', timestamp: '', rawBody: '[]' })
    ).toBe(false);
  });

  test('a garbage public key is a rejection, not a throw', () => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = 'bm90LWEta2V5';
    expect(
      verifyEventSignature({ signature: 'YWJj', timestamp: '1', rawBody: '[]' })
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The event webhook
// ─────────────────────────────────────────────────────────────────────────────

describe('handleSendgridEventWebhook', () => {
  test('an unsigned batch is a 401 and processes nothing', async () => {
    delete process.env.SENDGRID_WEBHOOK_ALLOW_UNSIGNED;
    const r = await handleSendgridEventWebhook(
      events({ event: 'bounce', email: EMAIL }),
      UNSIGNED
    );
    expect(r.status).toBe(401);
    expect(suppressMock).not.toHaveBeenCalled();
  });

  test('a hard bounce suppresses, marks the address invalid, and notes why', async () => {
    const r = await handleSendgridEventWebhook(
      events({ event: 'bounce', email: EMAIL }),
      UNSIGNED
    );
    expect(r).toMatchObject({ success: true, status: 200, processed: 1 });
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'hard-bounce',
      'sg-event:bounce'
    );
    // The trustworthy top-level key the send gate reads.
    expect(chat().email_invalid).toBe(true);
    // A bounce is not an opt-out: consent was never withdrawn.
    expect(chat().email_opt_out).toBe(false);
  });

  test('an unsubscribe opts the EMAIL channel out and labels the chat', async () => {
    await handleSendgridEventWebhook(
      events({ event: 'unsubscribe', email: EMAIL }),
      UNSIGNED
    );
    expect(chat().email_opt_out).toBe(true);
    expect(chat().labels).toContain('email_opted_out');
    expect((chat().memory as Record<string, unknown>)._email_opt_out).toBe(
      true
    );
  });

  test('a spam report is treated as an opt-out with its own wording', async () => {
    await handleSendgridEventWebhook(
      events({ event: 'spamreport', email: EMAIL }),
      UNSIGNED
    );
    expect(chat().email_opt_out).toBe(true);
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'spam-complaint',
      'sg-event:spamreport'
    );
  });

  test('NONE of these events marks the prospect Lost or touches the phone', async () => {
    // A bad address or withdrawn email consent says nothing about reachability by phone.
    store.set(`chats/${CHAT}/tasks/t_call`, {
      type: 'call_followup',
      executed: false,
      data: {},
    });
    await handleSendgridEventWebhook(
      events({ event: 'unsubscribe', email: EMAIL }),
      UNSIGNED
    );
    expect(chat().stage).toBe('Contacted');
    expect(chat().phone_opt_out).toBeUndefined();
    // The call cadence survives — a different channel.
    expect(store.get(`chats/${CHAT}/tasks/t_call`)).toBeDefined();
  });

  test('pending EMAIL touches are cancelled', async () => {
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    await handleSendgridEventWebhook(
      events({ event: 'unsubscribe', email: EMAIL }),
      UNSIGNED
    );
    expect(store.get(`chats/${CHAT}/tasks/t_email`)).toBeUndefined();
  });

  test('`dropped` is suppress-ONLY — no chat flag', async () => {
    // A drop is usually a downstream effect of an already-suppressed address, so flagging the chat
    // off it would be a false signal.
    await handleSendgridEventWebhook(
      events({ event: 'dropped', email: EMAIL }),
      UNSIGNED
    );
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'sg-dropped',
      'sg-event:dropped'
    );
    expect(chat().email_opt_out).toBe(false);
    expect(chat().email_invalid).toBeUndefined();
  });

  test('non-compliance events are skipped and never counted', async () => {
    // Opens, clicks and deliveries arrive through the same endpoint.
    const r = await handleSendgridEventWebhook(
      events(
        { event: 'open', email: EMAIL },
        { event: 'click', email: EMAIL },
        { event: 'delivered', email: EMAIL }
      ),
      UNSIGNED
    );
    expect(r.processed).toBe(0);
    expect(suppressMock).not.toHaveBeenCalled();
  });

  test('an event with no address is skipped', async () => {
    const r = await handleSendgridEventWebhook(
      events({ event: 'bounce', email: '' }),
      UNSIGNED
    );
    expect(r.processed).toBe(0);
  });

  test('a batch processes every compliance event in it', async () => {
    const r = await handleSendgridEventWebhook(
      events(
        { event: 'bounce', email: 'a@x.com' },
        { event: 'open', email: 'b@x.com' },
        { event: 'spamreport', email: 'c@x.com' }
      ),
      UNSIGNED
    );
    expect(r.processed).toBe(2);
    expect(suppressMock).toHaveBeenCalledTimes(2);
  });

  test('a non-array payload falls back to parsing the raw body', async () => {
    const rawBody = '[{"event":"bounce","email":"jane@corp.com"}]';
    const r = await handleSendgridEventWebhook(undefined, {
      ...UNSIGNED,
      rawBody,
    });
    expect(r.processed).toBe(1);
  });

  test('an unparseable body is a 400', async () => {
    const r = await handleSendgridEventWebhook(undefined, {
      ...UNSIGNED,
      rawBody: 'not json',
    });
    expect(r).toMatchObject({
      success: false,
      status: 400,
      error: 'bad payload',
    });
  });

  test('malformed entries in a batch are skipped without derailing it', async () => {
    const r = await handleSendgridEventWebhook(
      [null, 'string', 42, { event: 'bounce', email: EMAIL }] as unknown[],
      UNSIGNED
    );
    expect(r.processed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The send log
// ─────────────────────────────────────────────────────────────────────────────

describe('updateSendLog', () => {
  test('the log_id custom arg is the cheapest correlation and wins', async () => {
    store.set(`${SEND_LOG}/log_1`, { recipient: EMAIL, status: 'sent' });
    await updateSendLog({ log_id: 'log_1' }, 'bounced');
    expect(store.get(`${SEND_LOG}/log_1`)?.status).toBe('bounced');
  });

  test('falls back to the provider message id', async () => {
    store.set(`${SEND_LOG}/log_2`, {
      recipient: EMAIL,
      sg_message_id: 'abc123',
      status: 'sent',
    });
    // SendGrid appends a suffix after a dot; only the base id is stored.
    await updateSendLog({ sg_message_id: 'abc123.filter0001' }, 'bounced');
    expect(store.get(`${SEND_LOG}/log_2`)?.status).toBe('bounced');
  });

  test('falls back to the latest row for the recipient', async () => {
    store.set(`${SEND_LOG}/log_old`, {
      recipient: EMAIL,
      sent_at: '2026-07-01T00:00:00Z',
      status: 'sent',
    });
    store.set(`${SEND_LOG}/log_new`, {
      recipient: EMAIL,
      sent_at: '2026-08-01T00:00:00Z',
      status: 'sent',
    });
    await updateSendLog({ email: EMAIL }, 'complained');
    expect(store.get(`${SEND_LOG}/log_new`)?.status).toBe('complained');
    expect(store.get(`${SEND_LOG}/log_old`)?.status).toBe('sent');
  });

  test('no correlation at all is a silent no-op, not a throw', async () => {
    await expect(updateSendLog({}, 'bounced')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat flagging
// ─────────────────────────────────────────────────────────────────────────────

describe('flagChatsForEmailEvent', () => {
  test('writes the flag, the memory mirror, the activity, and a visible note', async () => {
    await flagChatsForEmailEvent(EMAIL, {
      opt_out: true,
      activity_event: 'unsubscribe',
      note_suffix: 'unsubscribed from emails.',
    });
    expect(chat().email_opt_out).toBe(true);
    // The note names the prospect, so the thread explains itself.
    // The visible note is an internal messages_v3 entry, not a `messages` doc.
    const notes = store
      .paths(`chats/${CHAT}/messages_v3`)
      .map((p) => JSON.stringify(store.get(p)));
    expect(notes.join()).toContain('Jane unsubscribed from emails.');
  });

  test('falls back to the address when there is no name', async () => {
    seedOutboundChat({ memory: { customer_email: EMAIL } });
    await flagChatsForEmailEvent(EMAIL, {
      opt_out: true,
      activity_event: 'unsubscribe',
      note_suffix: 'opted out.',
    });
    const notes = store
      .paths(`chats/${CHAT}/messages_v3`)
      .map((p) => JSON.stringify(store.get(p)));
    expect(notes.join()).toContain(`${EMAIL} opted out.`);
  });

  test('only_if_missing SKIPS an already-flagged chat, so a backfill posts no duplicate note', async () => {
    seedOutboundChat({ email_opt_out: true });
    await flagChatsForEmailEvent(EMAIL, {
      opt_out: true,
      activity_event: 'unsubscribe',
      note_suffix: 'unsubscribed.',
      only_if_missing: true,
    });
    expect(store.paths(`chats/${CHAT}/messages_v3`)).toHaveLength(0);
  });

  test('only_if_missing still flags a chat that is NOT yet flagged', async () => {
    await flagChatsForEmailEvent(EMAIL, {
      opt_out: true,
      activity_event: 'unsubscribe',
      note_suffix: 'unsubscribed.',
      only_if_missing: true,
    });
    expect(chat().email_opt_out).toBe(true);
  });

  test('an unknown address is a no-op returning null', async () => {
    store.reset();
    expect(await flagChatsForEmailEvent('nobody@nowhere.com', {})).toBeNull();
  });
});

describe('cancelPendingEmailTouches', () => {
  test('cancels email nudges and leaves call tasks alone', async () => {
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    store.set(`chats/${CHAT}/tasks/t_call`, {
      type: 'call_followup',
      executed: false,
      data: {},
    });
    expect(await cancelPendingEmailTouches(EMAIL)).toBe(CHAT);
    expect(store.get(`chats/${CHAT}/tasks/t_email`)).toBeUndefined();
    expect(store.get(`chats/${CHAT}/tasks/t_call`)).toBeDefined();
  });

  test('an unknown address returns null without throwing', async () => {
    store.reset();
    expect(await cancelPendingEmailTouches('nobody@nowhere.com')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

describe('unsubscribe', () => {
  test('GET renders a confirmation page and suppresses NOTHING', async () => {
    // Mail scanners follow every link; a suppressing GET would unsubscribe a whole domain.
    const r = handleUnsubscribeGet(EMAIL, 'tok');
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('text/html');
    expect(r.body).toContain(EMAIL);
    expect(r.body).toContain('method="POST"');
    expect(suppressMock).not.toHaveBeenCalled();
    expect(chat().email_opt_out).toBe(false);
  });

  test('POST is the real thing: suppress, cancel, flag, note', async () => {
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    const r = await handleUnsubscribePost(EMAIL, 'tok');
    expect(r.status).toBe(200);
    expect(r.body).toContain('You have been unsubscribed');
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'unsubscribed',
      'unsub-endpoint'
    );
    expect(chat().email_opt_out).toBe(true);
    expect(chat().labels).toContain('email_opted_out');
    expect(store.get(`chats/${CHAT}/tasks/t_email`)).toBeUndefined();
  });

  test('an invalid token is a 400 with NO side effect, on either verb', async () => {
    verifyToken.mockReturnValue(false);
    const get = handleUnsubscribeGet(EMAIL, 'bad');
    expect(get.status).toBe(400);
    const post = await handleUnsubscribePost(EMAIL, 'bad');
    expect(post.status).toBe(400);
    expect(suppressMock).not.toHaveBeenCalled();
    expect(chat().email_opt_out).toBe(false);
  });

  test('a missing address is rejected before the token is even checked', async () => {
    expect(handleUnsubscribeGet('', 'tok').status).toBe(400);
    expect((await handleUnsubscribePost('', 'tok')).status).toBe(400);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('the address is normalised before anything is done with it', async () => {
    await handleUnsubscribePost('  JANE@Corp.com  ', 'tok');
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'unsubscribed',
      'unsub-endpoint'
    );
  });
});
