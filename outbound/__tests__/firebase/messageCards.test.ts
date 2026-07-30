/**
 * @jest-environment node
 *
 * The `messages_v3` / `activities` / `notifications` builders.
 *
 * The highest-value assertion here is the outbound-specific call-card rule: a `make_phone_call`
 * card is written ONLY when the call was actually placed. Getting that wrong puts a phantom "we
 * called them" card in the conversation for a call that was deferred by business hours or blocked
 * by an opt-out — visible to a human, and wrong.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  MESSAGE_TOOLS,
  addMessagesV3AndActivities,
  buildNotification,
  buildV3MessageFromTool,
  buildV3MessageFromUserText,
  deriveActivityStatus,
} from '../../firebase/outboundChatMessages';

const TS = new Date('2026-03-04T12:00:00.000Z');

beforeEach(() => {
  store.reset();
});

describe('buildV3MessageFromTool — the call-placed rule', () => {
  it('writes a card when the call was actually placed', async () => {
    const card = await buildV3MessageFromTool(
      'make_phone_call',
      { phone_number: '+13035550123' },
      {
        status: 'in_progress',
        call_id: 'conv_abc',
        phone_number: '+13035550123',
      },
      TS
    );
    expect(card).not.toBeNull();
    expect(card!.type).toBe('call');
    expect(card!.direction).toBe('outbound');
    expect(card!.content.callId).toBe('conv_abc');
    expect(card!.content.outcome).toBe('in_progress');
  });

  it.each([
    ['deferred', { status: 'deferred', reason: 'outside business hours' }],
    ['skipped', { status: 'skipped', reason: 'phone opted out' }],
    ['blocked', { status: 'blocked', reason: 'dnc' }],
    ['errored', { status: 'failed', error: 'provider 500' }],
  ])('writes NO card when the call was %s', async (_label, result) => {
    expect(
      await buildV3MessageFromTool('make_phone_call', {}, result, TS)
    ).toBeNull();
  });

  it('writes NO card when in_progress but the call_id is missing', async () => {
    // Both halves of the condition are required — an in_progress result with no id means the
    // provider never returned a conversation, so nothing was actually dialled.
    expect(
      await buildV3MessageFromTool(
        'make_phone_call',
        {},
        { status: 'in_progress' },
        TS
      )
    ).toBeNull();
  });

  it('attaches the recording when one is already present', async () => {
    const card = await buildV3MessageFromTool(
      'make_phone_call',
      {},
      {
        status: 'in_progress',
        call_id: 'c1',
        recording_url: 'https://x/r.mp3',
      },
      TS
    );
    expect(card!.attachments).toEqual([
      { type: 'audio', caption: 'Call recording', url: 'https://x/r.mp3' },
    ]);
  });

  it('always writes a card for a RECEIVED call, regardless of status', async () => {
    // Inbound calls are not subject to the placed-check: it happened by definition.
    const card = await buildV3MessageFromTool(
      'received_phone_call',
      {},
      { status: '' },
      TS
    );
    expect(card).not.toBeNull();
    expect(card!.direction).toBe('inbound');
    expect(card!.sender.kind).toBe('customer');
    expect(card!.content.outcome).toBe('received');
  });
});

describe('buildV3MessageFromTool — messaging branches', () => {
  it('maps a WhatsApp send to an outbound customer card', async () => {
    const card = await buildV3MessageFromTool(
      'send_whatsapp_message',
      { body: 'hello there' },
      { status: 'sent' },
      TS
    );
    expect(card).toMatchObject({
      type: 'text',
      direction: 'outbound',
      sender: { kind: 'ai' },
      recipient: 'customer',
      content: { body: 'hello there' },
      status: 'delivered',
      source: 'whatsapp',
    });
  });

  it('marks a failed send as failed rather than delivered', async () => {
    const card = await buildV3MessageFromTool(
      'send_whatsapp_message',
      { body: 'x' },
      { status: 401 },
      TS
    );
    expect(card!.status).toBe('failed');
  });

  it('maps an admin send to direction=internal', async () => {
    const card = await buildV3MessageFromTool(
      'send_whatsapp_message_to_admin',
      { body: 'fyi', phone_number: '+15005550006' },
      {},
      TS
    );
    expect(card!.direction).toBe('internal');
    expect(card!.recipient).toBe('admin');
  });

  it('marks a human-sent message with sender.kind=admin', async () => {
    const card = await buildV3MessageFromTool(
      'send_whatsapp_message_by_human',
      { body: 'typed by a person', attachment: ['https://x/a.pdf'] },
      {},
      TS
    );
    expect(card!.sender.kind).toBe('admin');
    expect(card!.attachments).toEqual([
      { type: 'doc', caption: '', url: 'https://x/a.pdf' },
    ]);
  });

  it('resolves attachment ids through knowledge_sources', async () => {
    store.set('knowledge_sources/ks1', {
      data: { content: 'https://cdn/x/brochure.pdf' },
    });
    const card = await buildV3MessageFromTool(
      'send_whatsapp_message_with_attachment',
      { body: 'see attached', attachment_ids: ['ks1', 'missing'] },
      {},
      TS
    );
    // The missing id is skipped, not rendered as an empty attachment.
    expect(card!.attachments).toEqual([
      { type: 'doc', caption: '', url: 'https://cdn/x/brochure.pdf' },
    ]);
  });

  it('returns null for a tool with no card representation', async () => {
    expect(
      await buildV3MessageFromTool(
        'mark_prospect_lost',
        {},
        { status: 'success' },
        TS
      )
    ).toBeNull();
  });
});

describe('buildV3MessageFromUserText', () => {
  it('decodes the double-nested customer payload', () => {
    const inner = JSON.stringify({
      text: 'is this still available?',
      voice_note_url: null,
      attachment: null,
      source: 'whatsapp',
    });
    const card = buildV3MessageFromUserText(
      {
        text: JSON.stringify({
          userType: 'customer',
          from: '15551230000',
          text: inner,
        }),
      },
      TS
    );
    expect(card).toMatchObject({
      direction: 'inbound',
      sender: { kind: 'customer' },
      content: { body: 'is this still available?' },
      source: 'whatsapp',
    });
  });

  it('collects a voice note and attachments with their caption', () => {
    const inner = JSON.stringify({
      text: '',
      voice_note_url: 'https://x/v.ogg',
      attachment: 'https://x/p.png',
      caption: 'look',
    });
    const card = buildV3MessageFromUserText(
      { text: JSON.stringify({ userType: 'customer', text: inner }) },
      TS
    );
    expect(card!.attachments).toEqual([
      { type: 'audio', caption: 'look', url: 'https://x/v.ogg' },
      { type: 'image', caption: 'look', url: 'https://x/p.png' },
    ]);
  });

  it('extracts the notes field from a structured admin payload', () => {
    const adminInner =
      '{"original_date": "2026-03-04", "original_time": "10:00", ' +
      '"timezone": "UTC", "notes": "chase this one"}';
    const card = buildV3MessageFromUserText(
      { text: JSON.stringify({ userType: 'admin', text: adminInner }) },
      TS
    );
    expect(card).toMatchObject({
      direction: 'internal',
      sender: { kind: 'admin' },
      content: { body: 'chase this one' },
      source: 'virtuans',
    });
  });

  it('keeps plain admin text when it is not the structured payload', () => {
    // Admin messages are frequently just a sentence; losing them would be worse than not parsing.
    const card = buildV3MessageFromUserText(
      { text: JSON.stringify({ userType: 'admin', text: 'just call them' }) },
      TS
    );
    expect(card!.content.body).toBe('just call them');
  });

  it('falls back to inbound customer for an unknown userType', () => {
    const card = buildV3MessageFromUserText(
      { text: JSON.stringify({ userType: 'robot', text: 'beep' }) },
      TS
    );
    expect(card).toMatchObject({
      direction: 'inbound',
      content: { body: 'beep' },
    });
  });

  it('returns null on unparseable input instead of throwing', () => {
    expect(buildV3MessageFromUserText({ text: 'not json' }, TS)).toBeNull();
  });
});

describe('deriveActivityStatus', () => {
  it('maps in_progress to pending', () => {
    expect(deriveActivityStatus({ status: 'in_progress' })).toBe('pending');
  });

  it.each(['skipped', 'blocked', 'deferred'])(
    'keeps the by-design outcome %s distinct from failed',
    (status) => {
      expect(deriveActivityStatus({ status })).toBe(status);
    }
  );

  it('treats the STRING "false" success flag as failed', () => {
    // Some tools return success as a string; comparing against a boolean would miss it.
    expect(deriveActivityStatus({ success: 'false' })).toBe('failed');
  });

  it('treats a present error as failed', () => {
    expect(deriveActivityStatus({ error: 'boom' })).toBe('failed');
  });

  it('defaults to success', () => {
    expect(deriveActivityStatus({})).toBe('success');
    expect(deriveActivityStatus(null)).toBe('success');
  });
});

describe('buildNotification', () => {
  it.each(['failed', 'no-answer', 'busy'])(
    'raises call_failed for a %s call',
    (outcome) => {
      const n = buildNotification(
        'make_phone_call',
        {},
        { status: outcome, phone_number: '+1303' },
        'success',
        TS
      );
      expect(n).toMatchObject({ type: 'call_failed', severity: 'warning' });
      expect(n!.title).toBe(`Call failed — ${outcome}`);
      expect(n!.detail).toContain('Outbound call to +1303');
    }
  );

  it('labels a received-call failure as Inbound', () => {
    const n = buildNotification(
      'received_phone_call',
      {},
      { status: 'busy' },
      'success',
      TS
    );
    expect(n!.detail).toContain('Inbound call to');
  });

  it('raises tool_error for a failed activity', () => {
    const n = buildNotification(
      'email',
      { to: 'a@b.c' },
      { error: 'smtp down' },
      'failed',
      TS
    );
    expect(n).toMatchObject({ type: 'tool_error', severity: 'error' });
    expect(n!.detail).toBe('smtp down');
  });

  it('truncates a long error detail to 500 chars', () => {
    const n = buildNotification(
      'email',
      {},
      { error: 'x'.repeat(900) },
      'failed',
      TS
    );
    expect(n!.detail).toHaveLength(500);
  });

  it('stays silent for a successful call and a by-design skip', () => {
    // This collection must stay sparse or it becomes noise a human learns to ignore.
    expect(
      buildNotification(
        'make_phone_call',
        {},
        { status: 'in_progress' },
        'success',
        TS
      )
    ).toBeNull();
    expect(
      buildNotification('email', {}, { status: 'deferred' }, 'deferred', TS)
    ).toBeNull();
  });
});

describe('addMessagesV3AndActivities', () => {
  const chatId = 'chat1';

  beforeEach(() => {
    store.set(`chats/${chatId}`, { type: 'outbound', memory: {} });
  });

  it('writes a card and an activity for a placed call', async () => {
    const [cards, activities] = await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'tu1',
                name: 'make_phone_call',
                input: { phone: '+1' },
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tu1',
                content: [{ json: { status: 'in_progress', call_id: 'c1' } }],
              },
            },
          ],
        },
      ],
      TS
    );
    expect(cards).toHaveLength(1);
    expect(activities).toHaveLength(1);
    expect(store.collection(`chats/${chatId}/messages_v3`)).toHaveLength(1);
    expect(store.collection(`chats/${chatId}/activities`)).toHaveLength(1);
  });

  it('records a deferred call as an activity with NO conversation card', async () => {
    const [cards, activities] = await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'assistant',
          content: [
            { text: 'It is 9pm for them, I will wait.' },
            {
              toolUse: { toolUseId: 'tu1', name: 'make_phone_call', input: {} },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tu1',
                content: [
                  {
                    json: {
                      status: 'deferred',
                      reason: 'outside business hours',
                      retry_at: '9am',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      TS
    );
    expect(cards).toHaveLength(0);
    expect(activities).toHaveLength(1);

    const [, activity] = store.collection(`chats/${chatId}/activities`)[0];
    const toolCall = activity.toolCall as Record<string, unknown>;
    expect(toolCall.status).toBe('deferred');
    // The assistant's reasoning is retained so dropping the dead turn loses no context.
    expect(String(toolCall.reasoning)).toContain('It is 9pm for them');
    expect(String(toolCall.reasoning)).toContain(
      'Outcome: outside business hours'
    );
    expect(String(toolCall.reasoning)).toContain('Retry at: 9am');
  });

  it('omits reasoning from a successful activity', async () => {
    await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 'tu1', name: 'noop', input: {} } }],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tu1',
                content: [{ json: { status: 'ok' } }],
              },
            },
          ],
        },
      ],
      TS
    );
    const [, activity] = store.collection(`chats/${chatId}/activities`)[0];
    expect(
      (activity.toolCall as Record<string, unknown>).reasoning
    ).toBeUndefined();
  });

  it('tolerates a toolResult with no matching toolUse', async () => {
    // The source's messages_v2 writer raised here and lost the whole batch.
    const [cards, activities] = await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'orphan',
                content: [{ json: { status: 'ok' } }],
              },
            },
          ],
        },
      ],
      TS
    );
    expect(cards).toHaveLength(0);
    expect(activities).toHaveLength(1);
  });

  it('increments unread exactly once per inbound customer message', async () => {
    const inner = JSON.stringify({
      text: 'hi',
      voice_note_url: null,
      attachment: null,
    });
    await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'user',
          content: [
            { text: JSON.stringify({ userType: 'customer', text: inner }) },
          ],
        },
      ],
      TS
    );
    expect(store.get(`chats/${chatId}`)!.unread_count).toBe(1);
  });

  it('activitiesOnly mode writes activities but no cards', async () => {
    const [cards, activities] = await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'tu1',
                name: 'send_whatsapp_message',
                input: { body: 'x' },
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tu1',
                content: [{ json: { status: 'blocked' } }],
              },
            },
          ],
        },
      ],
      TS,
      true
    );
    expect(cards).toHaveLength(0);
    expect(activities).toHaveLength(1);
    expect(store.collection(`chats/${chatId}/messages_v3`)).toHaveLength(0);
  });

  it('stamps sms_owner=oversee on sms cards of a non-sub-agent chat', async () => {
    await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'tu1',
                name: 'send_sms_message_using_twilio',
                input: { body: 'x' },
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tu1',
                content: [{ json: { status: 'sent' } }],
              },
            },
          ],
        },
      ],
      TS
    );
    const [, card] = store.collection(`chats/${chatId}/messages_v3`)[0];
    expect(card.sms_owner).toBe('oversee');
  });

  it('duplicates cards and activities to the parent chat for an sms sub-agent chat', async () => {
    store.set(`chats/${chatId}`, {
      type: 'outbound',
      memory: { is_sms_agent: true, parent_chat_id: 'parent1' },
    });
    store.set('chats/parent1', { type: 'outbound', memory: {} });

    await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'tu1',
                name: 'send_sms_message_using_twilio',
                input: { body: 'x' },
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'tu1',
                content: [{ json: { status: 'sent' } }],
              },
            },
          ],
        },
      ],
      TS
    );

    expect(store.collection('chats/parent1/messages_v3')).toHaveLength(1);
    expect(store.collection('chats/parent1/activities')).toHaveLength(1);
    const [, parentCard] = store.collection('chats/parent1/messages_v3')[0];
    expect(parentCard.sms_owner).toBe('sms_agent');
  });

  it('gives each write a distinct, ordered timestamp derived from the base', async () => {
    const inner = JSON.stringify({
      text: 'a',
      voice_note_url: null,
      attachment: null,
    });
    await addMessagesV3AndActivities(
      chatId,
      [
        {
          role: 'user',
          content: [
            { text: JSON.stringify({ userType: 'customer', text: inner }) },
            { text: JSON.stringify({ userType: 'customer', text: inner }) },
          ],
        },
      ],
      TS
    );
    const stamps = store
      .collection(`chats/${chatId}/messages_v3`)
      .map(([, d]) => (d.timestamp as Date).getTime())
      .sort((a, b) => a - b);
    expect(stamps).toEqual([TS.getTime(), TS.getTime() + 1]);
  });
});

describe('MESSAGE_TOOLS', () => {
  it('retains the unbound channel tools so a future send still produces a card', () => {
    // Trimming this allowlist to only what is implemented today would silently downgrade a
    // WhatsApp/SMS send to an activity with no conversation card once those channels are bound.
    expect(MESSAGE_TOOLS.has('send_whatsapp_message')).toBe(true);
    expect(MESSAGE_TOOLS.has('send_sms_message_using_twilio')).toBe(true);
    expect(MESSAGE_TOOLS.has('send_web_message')).toBe(true);
    expect(MESSAGE_TOOLS.has('make_phone_call')).toBe(true);
    expect(MESSAGE_TOOLS.has('mark_prospect_lost')).toBe(false);
  });
});
