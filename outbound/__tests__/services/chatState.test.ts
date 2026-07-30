/**
 * @jest-environment node
 *
 * The non-gate half of `services/chat`: Bedrock history repair, the turn-outcome scans, persona-name
 * resolution, chat creation, and the durable call index.
 *
 * The history repair earns the most coverage here because its failure mode is the worst in the
 * system: Bedrock validates tool pairing BEFORE the model responds, so one dangling `toolUse` left
 * by a crashed turn makes every subsequent turn on that chat fail. The repair is what lets a chat
 * self-heal, and it has to do so without mangling valid history — hence the pass-through assertions
 * alongside the repair ones.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  MEETING_HOST_TITLE,
  assistantTextIfNoTool,
  buildDeterministicChatId,
  contactedMarkerKey,
  contactedMarkerValue,
  countActiveOutboundCalls,
  deleteOutboundCallIndex,
  findInProgressCallId,
  getOrCreateOutboundChat,
  getOutboundCallIndex,
  getOutboundChatByEmail,
  getWebChatByEmail,
  isOutboundChat,
  loadChatDoc,
  logEmailActivity,
  logEmailMessage,
  logInboundEmailToHistory,
  logInternalNote,
  markCallCompletedInActivities,
  markCallCompletedInMessages,
  meetingHostFact,
  nameSlug,
  notesForFailedActions,
  pronouncePhoneNumber,
  recentConversationContext,
  repairOutboundHistory,
  resolveOutboundName,
  saveOutboundCallIndex,
  setChatType,
  turnIsByDesignGated,
  updateEmailMeta,
} from '../../services/chat';
import type { BedrockMessage } from '../../types';

beforeEach(() => {
  store.reset();
});

/** A `toolResult` block carrying the `{json}` payload the scans read. */
function toolResult(id: string, json: Record<string, unknown>) {
  return { toolResult: { toolUseId: id, content: [{ json }] } };
}

function toolUse(id: string, name: string) {
  return { toolUse: { toolUseId: id, name, input: {} } };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('buildDeterministicChatId', () => {
  it('is stable for the same inputs — one doc per person, so only one create() wins', () => {
    expect(buildDeterministicChatId('agentA', '+15551230000')).toBe(
      buildDeterministicChatId('agentA', '+15551230000')
    );
  });

  it('sanitizes every disallowed character individually', () => {
    // Not run-collapsing: each unsafe char becomes its own underscore.
    expect(buildDeterministicChatId('a/b', 'c.d')).toBe('a_b__c_d');
    expect(buildDeterministicChatId('a@b.com', 'x')).toBe('a_b_com__x');
  });

  it('strips leading and trailing underscores, then falls back to a placeholder', () => {
    expect(buildDeterministicChatId('///', '...')).toBe('agent__user');
    expect(buildDeterministicChatId('', '')).toBe('agent__user');
    expect(buildDeterministicChatId(null, undefined)).toBe('agent__user');
  });

  it('preserves already-safe characters, including dashes and underscores', () => {
    expect(buildDeterministicChatId('ag-1', 'us_2')).toBe('ag-1__us_2');
  });
});

describe('pronouncePhoneNumber — punctuation is the only TTS pacing lever available', () => {
  it('groups a US number country-code-first, 3-3-4, commas within groups', () => {
    expect(pronouncePhoneNumber('+17816791321')).toBe(
      'plus one. seven, eight, one. six, seven, nine. one, three, two, one'
    );
  });

  it('emits no trailing period — templates add their own sentence punctuation', () => {
    expect(pronouncePhoneNumber('+17816791321').endsWith('one')).toBe(true);
  });

  it('handles a bare 10-digit number with no country code', () => {
    expect(pronouncePhoneNumber('7816791321')).toBe(
      'seven, eight, one. six, seven, nine. one, three, two, one'
    );
  });

  it('assumes country code 1 when a leading + is present but no cc digits remain', () => {
    expect(pronouncePhoneNumber('+7816791321')).toContain('plus one');
  });

  it('strips formatting before grouping', () => {
    expect(pronouncePhoneNumber('(781) 679-1321')).toBe(
      pronouncePhoneNumber('7816791321')
    );
  });

  it('passes through anything that is not a groupable number', () => {
    expect(pronouncePhoneNumber('this number')).toBe('this number');
    expect(pronouncePhoneNumber('12345')).toBe('12345');
    expect(pronouncePhoneNumber('')).toBe('');
  });
});

describe('persona name is data, not code', () => {
  it('slugs a name for the dedup marker key', () => {
    expect(nameSlug('Lily')).toBe('lily');
    expect(nameSlug('Ava B')).toBe('ava_b');
    expect(nameSlug('!!!')).toBe('agent');
    expect(contactedMarkerKey('Lily')).toBe('_lily_last_contacted');
  });

  it('resolves the name from chat memory first — the seeded fast path', async () => {
    await expect(
      resolveOutboundName({ sales_agent_name: 'Nova' })
    ).resolves.toBe('Nova');
  });

  it('prefers a caller-supplied agent doc over the agent lookup', async () => {
    await expect(
      resolveOutboundName({}, { sales_agent_name: 'Rex' })
    ).resolves.toBe('Rex');
  });

  it('falls back to the chat agent doc, which is what makes an un-seeded chat resolve correctly', async () => {
    store.set('agents/ag1', { sales_agent_name: 'Ava' });
    await expect(resolveOutboundName({ agent_id: 'ag1' })).resolves.toBe('Ava');
  });

  it('reads a chat id by loading its memory', async () => {
    store.set('chats/c1', { memory: { sales_agent_name: 'Sol' } });
    await expect(resolveOutboundName('c1')).resolves.toBe('Sol');
  });

  it('lands on the generic default when nothing resolves', async () => {
    await expect(resolveOutboundName({})).resolves.toBe('Lily');
    await expect(resolveOutboundName(null)).resolves.toBe('Lily');
  });

  it('reads the contacted marker under the NAME-DERIVED key', async () => {
    await expect(
      contactedMarkerValue({
        sales_agent_name: 'Nova',
        _nova_last_contacted: '2026-07-01T00:00:00Z',
      })
    ).resolves.toBe('2026-07-01T00:00:00Z');
  });

  it('falls back to the legacy fixed key so cadence never breaks mid-migration', async () => {
    await expect(
      contactedMarkerValue({
        sales_agent_name: 'Nova',
        _ava_last_contacted: '2026-06-01T00:00:00Z',
      })
    ).resolves.toBe('2026-06-01T00:00:00Z');
  });

  it('is undefined when the chat was never contacted', async () => {
    await expect(contactedMarkerValue({})).resolves.toBeUndefined();
  });
});

describe('meetingHostFact', () => {
  it('names the host and the fixed title', () => {
    const fact = meetingHostFact('Arnold Phipps');
    expect(fact).toContain('Arnold Phipps');
    expect(fact).toContain(MEETING_HOST_TITLE);
  });

  it('is empty when no host is known', () => {
    expect(meetingHostFact('')).toBe('');
    expect(meetingHostFact('   ')).toBe('');
    expect(meetingHostFact(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('repairOutboundHistory — the self-heal that unbricks a chat', () => {
  it('merges consecutive same-role messages into strict alternation', () => {
    const out = repairOutboundHistory([
      { role: 'user', content: [{ text: 'a' }] },
      { role: 'user', content: [{ text: 'b' }] },
      { role: 'assistant', content: [{ text: 'c' }] },
    ]) as BedrockMessage[];
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[0].content).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('drops a MID-HISTORY toolUse whose toolResult never arrived', () => {
    // This is the exact shape a crashed turn leaves behind, and it fails every later turn.
    const out = repairOutboundHistory([
      { role: 'user', content: [{ text: 'hi' }] },
      { role: 'assistant', content: [toolUse('tu1', 'send_email')] },
      { role: 'user', content: [{ text: 'still there?' }] },
      { role: 'assistant', content: [{ text: 'yes' }] },
    ]) as BedrockMessage[];
    const allBlocks = out.flatMap((m) => m.content ?? []);
    expect(allBlocks.some((b) => 'toolUse' in (b as object))).toBe(false);
  });

  it('drops an orphan toolResult with no preceding toolUse', () => {
    const out = repairOutboundHistory([
      { role: 'assistant', content: [{ text: 'hello' }] },
      {
        role: 'user',
        content: [toolResult('tu-missing', { status: 'success' })],
      },
    ]) as BedrockMessage[];
    const allBlocks = out.flatMap((m) => m.content ?? []);
    expect(allBlocks.some((b) => 'toolResult' in (b as object))).toBe(false);
  });

  it('KEEPS a properly paired toolUse/toolResult — it must not mangle valid history', () => {
    const out = repairOutboundHistory([
      { role: 'assistant', content: [toolUse('tu1', 'send_email')] },
      { role: 'user', content: [toolResult('tu1', { status: 'success' })] },
    ]) as BedrockMessage[];
    expect(out).toHaveLength(2);
    expect(out[0].content).toHaveLength(1);
    expect(out[1].content).toHaveLength(1);
  });

  it('keeps the answered tool of a multi-tool turn and drops only the unanswered one', () => {
    const out = repairOutboundHistory([
      {
        role: 'assistant',
        content: [
          toolUse('tu1', 'make_phone_call'),
          toolUse('tu2', 'send_email'),
        ],
      },
      { role: 'user', content: [toolResult('tu1', { status: 'success' })] },
    ]) as BedrockMessage[];
    const uses = (out[0].content ?? []).filter(
      (b) => 'toolUse' in (b as object)
    );
    expect(uses).toHaveLength(1);
    expect(
      (
        (uses[0] as Record<string, never>).toolUse as unknown as {
          toolUseId: string;
        }
      ).toolUseId
    ).toBe('tu1');
  });

  it('never ends on an assistant toolUse — nothing could answer it', () => {
    const out = repairOutboundHistory([
      { role: 'user', content: [{ text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ text: 'one moment' }, toolUse('tu9', 'x')],
      },
    ]) as BedrockMessage[];
    const last = out[out.length - 1];
    expect((last.content ?? []).some((b) => 'toolUse' in (b as object))).toBe(
      false
    );
  });

  it('drops messages left empty by the strip, then re-merges around the hole', () => {
    const out = repairOutboundHistory([
      { role: 'user', content: [{ text: 'a' }] },
      { role: 'assistant', content: [toolUse('tu1', 'x')] }, // becomes empty → dropped
      { role: 'user', content: [{ text: 'b' }] },
    ]) as BedrockMessage[];
    // The two user messages are now adjacent and must be merged, not left consecutive.
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('passes through an unexpected shape rather than risking a mangle', () => {
    const bad = [{ notARole: true }] as unknown as BedrockMessage[];
    expect(repairOutboundHistory(bad)).toBe(bad);
  });

  it('passes through empty and nullish input unchanged', () => {
    expect(repairOutboundHistory([])).toEqual([]);
    expect(repairOutboundHistory(null)).toBeNull();
    expect(repairOutboundHistory(undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('notesForFailedActions', () => {
  it('surfaces a blocked tool with its reason', () => {
    const notes = notesForFailedActions([
      { role: 'assistant', content: [toolUse('t1', 'send_email')] },
      {
        role: 'user',
        content: [
          toolResult('t1', { status: 'blocked', message: 'email opted out' }),
        ],
      },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('send_email');
    expect(notes[0]).toContain('email opted out');
  });

  it('says nothing when the turn succeeded', () => {
    expect(
      notesForFailedActions([
        { role: 'assistant', content: [toolUse('t1', 'send_email')] },
        { role: 'user', content: [toolResult('t1', { status: 'success' })] },
      ])
    ).toEqual([]);
  });

  it('suppresses a block that the SAME tool self-corrected later in the turn', () => {
    // send_email gated pre-booking, then sent post-booking: not a real failure.
    const notes = notesForFailedActions([
      { role: 'assistant', content: [toolUse('t1', 'send_email')] },
      { role: 'user', content: [toolResult('t1', { status: 'blocked' })] },
      { role: 'assistant', content: [toolUse('t2', 'send_email')] },
      { role: 'user', content: [toolResult('t2', { status: 'sent' })] },
    ]);
    expect(notes).toEqual([]);
  });

  it('does NOT suppress a different tool that failed alongside a success', () => {
    const notes = notesForFailedActions([
      {
        role: 'assistant',
        content: [
          toolUse('t1', 'send_email'),
          toolUse('t2', 'make_phone_call'),
        ],
      },
      {
        role: 'user',
        content: [
          toolResult('t1', { status: 'sent' }),
          toolResult('t2', { status: 'failed', error: 'no answer' }),
        ],
      },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('make_phone_call');
  });

  it('excludes `deferred`, which is a scheduled retry rather than a failure', () => {
    expect(
      notesForFailedActions([
        { role: 'assistant', content: [toolUse('t1', 'make_phone_call')] },
        { role: 'user', content: [toolResult('t1', { status: 'deferred' })] },
      ])
    ).toEqual([]);
  });

  it('catches a statusless failure via success:false or an error field', () => {
    expect(
      notesForFailedActions([
        { role: 'assistant', content: [toolUse('t1', 'x')] },
        { role: 'user', content: [toolResult('t1', { success: false })] },
      ])
    ).toHaveLength(1);
    expect(
      notesForFailedActions([
        { role: 'assistant', content: [toolUse('t1', 'x')] },
        { role: 'user', content: [toolResult('t1', { error: 'boom' })] },
      ])
    ).toHaveLength(1);
  });

  it('is empty for a turn with no tools at all', () => {
    expect(
      notesForFailedActions([{ role: 'assistant', content: [{ text: 'hi' }] }])
    ).toEqual([]);
    expect(notesForFailedActions(null)).toEqual([]);
  });
});

describe('turnIsByDesignGated — quiet for gates, loud for genuine failures', () => {
  it('is true when every tool ended in a by-design gate', () => {
    for (const status of ['skipped', 'blocked', 'deferred']) {
      expect(
        turnIsByDesignGated([
          { role: 'user', content: [toolResult('t1', { status })] },
        ])
      ).toBe(true);
    }
  });

  it('is FALSE for a genuine failure — it must stay visible in the chat', () => {
    expect(
      turnIsByDesignGated([
        { role: 'user', content: [toolResult('t1', { status: 'failed' })] },
      ])
    ).toBe(false);
    expect(
      turnIsByDesignGated([
        { role: 'user', content: [toolResult('t1', { success: false })] },
      ])
    ).toBe(false);
    expect(
      turnIsByDesignGated([
        { role: 'user', content: [toolResult('t1', { error: 'boom' })] },
      ])
    ).toBe(false);
  });

  it('is false when any real action succeeded', () => {
    expect(
      turnIsByDesignGated([
        {
          role: 'user',
          content: [
            toolResult('t1', { status: 'skipped' }),
            toolResult('t2', { status: 'success' }),
          ],
        },
      ])
    ).toBe(false);
  });

  it('is false on ANY ambiguity — an unrecognized status or no tool result', () => {
    expect(
      turnIsByDesignGated([
        { role: 'user', content: [toolResult('t1', { status: 'weird' })] },
      ])
    ).toBe(false);
    expect(
      turnIsByDesignGated([{ role: 'assistant', content: [{ text: 'hi' }] }])
    ).toBe(false);
    expect(turnIsByDesignGated([])).toBe(false);
    expect(turnIsByDesignGated(null)).toBe(false);
  });
});

describe('assistantTextIfNoTool', () => {
  it('returns the concatenated assistant text of a tool-free turn', () => {
    expect(
      assistantTextIfNoTool([
        { role: 'assistant', content: [{ text: 'I see no inbound email' }] },
      ])
    ).toBe('I see no inbound email');
  });

  it('joins multiple text blocks', () => {
    expect(
      assistantTextIfNoTool([
        { role: 'assistant', content: [{ text: 'one' }, { text: 'two' }] },
      ])
    ).toBe('one\ntwo');
  });

  it('returns null as soon as a tool ran — other scans own that case', () => {
    expect(
      assistantTextIfNoTool([
        { role: 'assistant', content: [{ text: 'x' }, toolUse('t1', 'y')] },
      ])
    ).toBeNull();
  });

  it('ignores the end-turn "Done" placeholder', () => {
    expect(
      assistantTextIfNoTool([
        { role: 'assistant', content: [{ text: 'Done' }] },
      ])
    ).toBeNull();
  });

  it('ignores user text', () => {
    expect(
      assistantTextIfNoTool([{ role: 'user', content: [{ text: 'hello' }] }])
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getOrCreateOutboundChat', () => {
  it('namespaces the doc id so an outbound lead can never overwrite an inbound chat', async () => {
    const { chatId, created } = await getOrCreateOutboundChat(
      'agentA',
      '+15551230000'
    );
    expect(chatId).toBe('outbound__agentA__15551230000');
    expect(created).toBe(true);
    // The inbound namespace for the same person is a different document entirely.
    expect(chatId).not.toBe(buildDeterministicChatId('agentA', '+15551230000'));
  });

  it('seeds the deterministic gate keys and the outbound type at creation', async () => {
    const { chatId } = await getOrCreateOutboundChat(
      'agentA',
      'a@b.com',
      'Ann'
    );
    const d = store.get(`chats/${chatId}`)!;
    expect(d.type).toBe('outbound');
    expect(d.phone_opt_out).toBe(false);
    expect(d.email_opt_out).toBe(false);
    expect(d.status).toBe('active');
    expect((d.memory as Record<string, unknown>).display_name).toBe('Ann');
  });

  it('reports created:false for an existing chat — the caller needs to know it was a collision', async () => {
    store.set('chats/outbound__agentA__15551230000', { type: 'outbound' });
    const r = await getOrCreateOutboundChat('agentA', '+15551230000');
    expect(r.created).toBe(false);
  });

  it('reuses a MIGRATED chat whose doc id still carries the old agent namespace', async () => {
    // The rebrand case: doc id kept the old agent, but agentId now points here. Without this the
    // re-enroll would create a duplicate under the new namespaced id.
    store.set('chats/outbound__oldAgent__15551230000', {
      type: 'outbound',
      agentId: 'agentA',
      userId: '+15551230000',
    });
    const r = await getOrCreateOutboundChat('agentA', '+15551230000');
    expect(r.chatId).toBe('outbound__oldAgent__15551230000');
    expect(r.created).toBe(false);
  });

  it('does NOT reuse a chat belonging to a different agent', async () => {
    store.set('chats/outbound__x__15551230000', {
      type: 'outbound',
      agentId: 'someoneElse',
      userId: '+15551230000',
    });
    const r = await getOrCreateOutboundChat('agentA', '+15551230000');
    expect(r.chatId).toBe('outbound__agentA__15551230000');
    expect(r.created).toBe(true);
  });

  it('does NOT reuse an INBOUND chat with the same userId', async () => {
    store.set('chats/agentA__15551230000', {
      agentId: 'agentA',
      userId: '+15551230000',
    }); // no type → inbound
    const r = await getOrCreateOutboundChat('agentA', '+15551230000');
    expect(r.chatId).toBe('outbound__agentA__15551230000');
    expect(r.created).toBe(true);
  });

  it('copies company_id off the agent and mirrors a dealer id under both spellings', async () => {
    store.set('agents/agentA', { company_id: 'co1' });
    const { chatId } = await getOrCreateOutboundChat(
      'agentA',
      'a@b.com',
      '',
      'dealer9'
    );
    const d = store.get(`chats/${chatId}`)!;
    expect(d.company_id).toBe('co1');
    expect(d.dealer_id).toBe('dealer9');
    expect(d.dealers_id).toBe('dealer9');
  });
});

describe('isOutboundChat / loadChatDoc / setChatType', () => {
  it('discriminates on the type field, reading the doc when not supplied', async () => {
    store.set('chats/c1', { type: 'outbound' });
    store.set('chats/c2', { type: 'inbound' });
    await expect(isOutboundChat('c1')).resolves.toBe(true);
    await expect(isOutboundChat('c2')).resolves.toBe(false);
    await expect(isOutboundChat('missing')).resolves.toBe(false);
    await expect(isOutboundChat('')).resolves.toBe(false);
  });

  it('uses a supplied doc without reading', async () => {
    await expect(isOutboundChat('c1', { type: 'outbound' })).resolves.toBe(
      true
    );
  });

  it('loadChatDoc returns {} for a missing chat rather than throwing', async () => {
    await expect(loadChatDoc('nope')).resolves.toEqual({});
    await expect(loadChatDoc('')).resolves.toEqual({});
  });

  it('setChatType stamps the field on a pre-existing chat', async () => {
    store.set('chats/c1', { memory: {} });
    await setChatType('c1');
    expect(store.get('chats/c1')!.type).toBe('outbound');
  });
});

describe('chat lookup by email is strictly one-directional', () => {
  beforeEach(() => {
    store.set('chats/ob1', {
      type: 'outbound',
      agentId: 'ag1',
      memory: { customer_email: 'a@b.com' },
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    });
    store.set('chats/ob2', {
      type: 'outbound',
      agentId: 'ag1',
      memory: { customer_email: 'a@b.com' },
      updatedAt: new Date('2026-07-20T00:00:00Z'),
    });
    store.set('chats/web1', {
      agentId: 'ag1',
      memory: { email: 'a@b.com' },
      updatedAt: new Date('2026-07-05T00:00:00Z'),
    });
  });

  it('returns the most recently updated OUTBOUND match', async () => {
    await expect(getOutboundChatByEmail('A@B.com')).resolves.toBe('ob2');
  });

  it('never falls back to an inbound chat, even on the same address', async () => {
    store.docs.delete('chats/ob1');
    store.docs.delete('chats/ob2');
    await expect(getOutboundChatByEmail('a@b.com')).resolves.toBeNull();
  });

  it('the web matcher is the mirror image — it excludes outbound chats', async () => {
    await expect(getWebChatByEmail('a@b.com')).resolves.toBe('web1');
  });

  it('filters by agent when one is given', async () => {
    await expect(
      getOutboundChatByEmail('a@b.com', 'other')
    ).resolves.toBeNull();
  });

  it('returns null for a falsy address', async () => {
    await expect(getOutboundChatByEmail('')).resolves.toBeNull();
    await expect(getWebChatByEmail('')).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('conversation logging', () => {
  it('writes an outbound email row with the internal classification label', async () => {
    await logEmailMessage('c1', 'body', 'outbound', 'Subj', {
      profile: 'outreach',
      origin: 'llm_tool',
    });
    const [[, row]] = store.collection('chats/c1/messages_v3');
    expect(row.direction).toBe('outbound');
    expect(row.status).toBe('sent');
    expect((row.sender as Record<string, unknown>).kind).toBe('ai');
    expect(row.email_label).toEqual({
      profile: 'outreach',
      origin: 'llm_tool',
    });
  });

  it('flips sender/recipient and status for an inbound email', async () => {
    await logEmailMessage('c1', 'body', 'inbound');
    const [[, row]] = store.collection('chats/c1/messages_v3');
    expect(row.status).toBe('delivered');
    expect((row.sender as Record<string, unknown>).kind).toBe('customer');
    expect(row.recipient).toBe('ai');
    expect('email_label' in row).toBe(false);
  });

  it('writes an inbound email into Bedrock history as a user text block', async () => {
    expect(
      await logInboundEmailToHistory('c1', 'hello there', 'Re: demo')
    ).toBe(true);
    const [[, row]] = store.collection('chats/c1/messages');
    expect(row.role).toBe('user');
    const text = String((row.content as Array<{ text: string }>)[0].text);
    expect(text).toContain('[Inbound email]');
    expect(text).toContain('Re: demo');
    expect(text).toContain('hello there');
  });

  it('refuses to write an empty body into history', async () => {
    expect(await logInboundEmailToHistory('c1', '   ')).toBe(false);
    expect(store.collection('chats/c1/messages')).toHaveLength(0);
  });

  it('maps each email event to its own activity name and message', async () => {
    await logEmailActivity('c1', 'unsubscribe', 'a@b.com', 'S');
    const [[, row]] = store.collection('chats/c1/activities');
    const tc = row.toolCall as Record<string, unknown>;
    expect(tc.toolName).toBe('email_unsubscribed');
    expect(tc.status).toBe('success');
    expect((tc.result as Record<string, unknown>).message).toContain(
      'unsubscribed'
    );
  });

  it('passes an unknown event through as its own name', async () => {
    await logEmailActivity('c1', 'weird_event');
    const [[, row]] = store.collection('chats/c1/activities');
    expect((row.toolCall as Record<string, unknown>).toolName).toBe(
      'weird_event'
    );
  });

  it('writes an internal note that is admin-visible but never sent', async () => {
    await logInternalNote('c1', 'gated');
    const [[, row]] = store.collection('chats/c1/messages_v3');
    expect(row.direction).toBe('internal');
    expect(row.recipient).toBe('admin');
    expect((row.sender as Record<string, unknown>).kind).toBe('ai');
  });
});

describe('recentConversationContext', () => {
  beforeEach(() => {
    store.set('chats/c1', { memory: { sales_agent_name: 'Nova' } });
    const rows: Array<[string, Record<string, unknown>]> = [
      [
        'm1',
        {
          timestamp: new Date('2026-07-01T00:00:00Z'),
          source: 'email',
          sender: { kind: 'ai' },
          content: { body: 'first touch', subject: 'Hi' },
        },
      ],
      [
        'm2',
        {
          timestamp: new Date('2026-07-02T00:00:00Z'),
          direction: 'internal',
          sender: { kind: 'admin' },
          content: { body: '@ai do a thing' },
        },
      ],
      [
        'm3',
        {
          timestamp: new Date('2026-07-03T00:00:00Z'),
          source: 'email',
          sender: { kind: 'customer' },
          content: { body: 'sounds good' },
        },
      ],
      [
        'm4',
        {
          timestamp: new Date('2026-07-04T00:00:00Z'),
          source: 'call',
          sender: { kind: 'ai' },
          content: { summary: 'discussed pricing' },
        },
      ],
    ];
    for (const [id, d] of rows) store.set(`chats/c1/messages_v3/${id}`, d);
  });

  it('returns real exchanges chronologically, labelled by channel and speaker', async () => {
    const out = await recentConversationContext('c1', 3);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('EMAIL · Nova: [Hi] first touch');
    expect(lines[1]).toBe('EMAIL · Customer: sounds good');
    expect(lines[2]).toBe('CALL · Nova: discussed pricing'); // call cards carry the summary
  });

  it('excludes internal entries and does not let them consume the limit', async () => {
    const out = await recentConversationContext('c1', 3);
    expect(out).not.toContain('@ai do a thing');
  });

  it('honours the limit, keeping the newest', async () => {
    const out = await recentConversationContext('c1', 1);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('discussed pricing');
  });

  it('truncates a long body', async () => {
    store.set('chats/c1/messages_v3/m5', {
      timestamp: new Date('2026-07-05T00:00:00Z'),
      source: 'email',
      sender: { kind: 'customer' },
      content: { body: 'x'.repeat(900) },
    });
    const out = await recentConversationContext('c1', 1);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(700);
  });

  it('is empty for a nonexistent chat or a non-positive limit', async () => {
    await expect(recentConversationContext('nope', 3)).resolves.toBe('');
    await expect(recentConversationContext('c1', 0)).resolves.toBe('');
    await expect(recentConversationContext('', 3)).resolves.toBe('');
  });
});

describe('updateEmailMeta — the per-chat rollup', () => {
  beforeEach(() => {
    store.set('chats/c1', { type: 'outbound' });
  });

  it('increments the status counter and records the last outcome', async () => {
    await updateEmailMeta('c1', {
      status: 'sent',
      profile: 'outreach',
      origin: 'llm_tool',
      recipient: 'A@B.com',
    });
    const meta = store.get('chats/c1')!.email_meta as Record<string, never>;
    expect((meta.counts as Record<string, number>).sent).toBe(1);
    expect((meta.by_profile as Record<string, number>).outreach).toBe(1);
    expect(meta.last_sent_at).toBeInstanceOf(Date);
    const last = meta.last_outcome as Record<string, unknown>;
    expect(last.status).toBe('sent');
    expect(last.recipient).toBe('a@b.com'); // lowercased
  });

  it('accumulates across calls', async () => {
    await updateEmailMeta('c1', { status: 'sent', profile: 'outreach' });
    await updateEmailMeta('c1', { status: 'sent', profile: 'reply' });
    await updateEmailMeta('c1', { status: 'failed' });
    const meta = store.get('chats/c1')!.email_meta as Record<string, never>;
    expect(meta.counts).toEqual({ sent: 2, failed: 1 });
    expect(meta.by_profile).toEqual({ outreach: 1, reply: 1 });
  });

  it('records by_profile and last_sent_at only for a send', async () => {
    await updateEmailMeta('c1', { status: 'skipped', profile: 'outreach' });
    const meta = store.get('chats/c1')!.email_meta as Record<string, never>;
    expect(meta.by_profile).toBeUndefined();
    expect(meta.last_sent_at).toBeUndefined();
  });

  it('ignores an unknown profile rather than writing a junk dot-path segment', async () => {
    await updateEmailMeta('c1', { status: 'sent', profile: 'nonsense' });
    const meta = store.get('chats/c1')!.email_meta as Record<string, never>;
    expect(meta.by_profile).toBeUndefined();
  });

  it('is a no-op for a status outside the fixed enum', async () => {
    await updateEmailMeta('c1', { status: 'bogus' });
    expect(store.get('chats/c1')!.email_meta).toBeUndefined();
  });

  it('truncates a long error', async () => {
    await updateEmailMeta('c1', { status: 'failed', error: 'e'.repeat(500) });
    const last = (store.get('chats/c1')!.email_meta as Record<string, never>)
      .last_outcome as Record<string, string>;
    expect(last.error).toHaveLength(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the durable call index', () => {
  it('round-trips call_id → chat_id and then deletes', async () => {
    await saveOutboundCallIndex('call1', 'c1', 'ag1');
    await expect(getOutboundCallIndex('call1')).resolves.toMatchObject({
      chat_id: 'c1',
      agent_id: 'ag1',
    });
    await deleteOutboundCallIndex('call1');
    await expect(getOutboundCallIndex('call1')).resolves.toEqual({});
  });

  it('returns {} rather than throwing for an unknown or falsy id', async () => {
    await expect(getOutboundCallIndex('nope')).resolves.toEqual({});
    await expect(getOutboundCallIndex('')).resolves.toEqual({});
  });

  it('ignores a save with a missing id on either side', async () => {
    await saveOutboundCallIndex('', 'c1');
    await saveOutboundCallIndex('call1', '');
    expect(store.collection('outbound_call_index')).toHaveLength(0);
  });

  it('counts only in-flight calls inside the staleness window', async () => {
    store.set('outbound_call_index/fresh', {
      chat_id: 'c1',
      created_at: new Date(Date.now() - 5 * 60_000),
    });
    store.set('outbound_call_index/stale', {
      chat_id: 'c2',
      created_at: new Date(Date.now() - 120 * 60_000),
    });
    await expect(countActiveOutboundCalls(20)).resolves.toBe(1);
  });
});

describe('flipping a completed call card', () => {
  it('updates the matching in_progress activity by call id', async () => {
    store.set('chats/c1/activities/a1', {
      timestamp: new Date(),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'in_progress',
        result: { call_id: 'call1', status: 'in_progress' },
      },
    });
    const n = await markCallCompletedInActivities(
      'c1',
      'call1',
      'went well',
      'completed'
    );
    expect(n).toBe(1);
    const tc = store.get('chats/c1/activities/a1')!.toolCall as Record<
      string,
      never
    >;
    expect(tc.status).toBe('completed');
    expect((tc.result as Record<string, unknown>).status).toBe('completed');
    expect((tc.result as Record<string, unknown>).summary).toBe('went well');
  });

  it('leaves a different call and an already-settled card alone', async () => {
    store.set('chats/c1/activities/other', {
      timestamp: new Date(),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'in_progress',
        result: { call_id: 'callOTHER', status: 'in_progress' },
      },
    });
    store.set('chats/c1/activities/settled', {
      timestamp: new Date(),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'completed',
        result: { call_id: 'call1', status: 'completed' },
      },
    });
    await expect(
      markCallCompletedInActivities('c1', 'call1', null, 'failed')
    ).resolves.toBe(0);
  });

  it('updates the toolResult json in `messages` so the next turn sees the call is done', async () => {
    store.set('chats/c1/messages/m1', {
      role: 'user',
      timestamp: new Date(),
      content: [
        {
          toolResult: {
            toolUseId: 't1',
            content: [{ json: { call_id: 'call1', status: 'in_progress' } }],
          },
        },
      ],
    });
    expect(
      await markCallCompletedInMessages('c1', 'call1', 'summary', 'completed')
    ).toBe(true);
    const content = store.get('chats/c1/messages/m1')!.content as Array<never>;
    const json = (
      (content[0] as Record<string, never>).toolResult as unknown as {
        content: Array<{ json: Record<string, unknown> }>;
      }
    ).content[0].json;
    expect(json.status).toBe('completed');
    expect(json.success).toBe('true');
    expect(json.summary).toBe('summary');
  });

  it('reports success:"false" for a non-completed outcome', async () => {
    store.set('chats/c1/messages/m1', {
      role: 'user',
      timestamp: new Date(),
      content: [
        {
          toolResult: {
            toolUseId: 't1',
            content: [{ json: { call_id: 'call1', status: 'in_progress' } }],
          },
        },
      ],
    });
    await markCallCompletedInMessages('c1', 'call1', null, 'failed');
    const content = store.get('chats/c1/messages/m1')!.content as Array<never>;
    const json = (
      (content[0] as Record<string, never>).toolResult as unknown as {
        content: Array<{ json: Record<string, unknown> }>;
      }
    ).content[0].json;
    expect(json.success).toBe('false');
  });

  it('returns false when nothing matches', async () => {
    await expect(
      markCallCompletedInMessages('c1', 'nope', null, 'completed')
    ).resolves.toBe(false);
  });
});

describe('findInProgressCallId', () => {
  it('returns the newest stuck in_progress call id', async () => {
    store.set('chats/c1/activities/old', {
      timestamp: new Date('2026-07-01T00:00:00Z'),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'in_progress',
        result: { call_id: 'older' },
      },
    });
    store.set('chats/c1/activities/new', {
      timestamp: new Date('2026-07-10T00:00:00Z'),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'in_progress',
        result: { call_id: 'newer' },
      },
    });
    await expect(findInProgressCallId('c1')).resolves.toBe('newer');
  });

  it('recognizes the from-number variant of the call tool', async () => {
    store.set('chats/c1/activities/a1', {
      timestamp: new Date(),
      toolCall: {
        toolName: 'make_phone_call_from_number',
        status: 'in_progress',
        result: { call_id: 'call9' },
      },
    });
    await expect(findInProgressCallId('c1')).resolves.toBe('call9');
  });

  it('is null when every card has settled', async () => {
    store.set('chats/c1/activities/a1', {
      timestamp: new Date(),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'completed',
        result: { call_id: 'call1', status: 'completed' },
      },
    });
    await expect(findInProgressCallId('c1')).resolves.toBeNull();
    await expect(findInProgressCallId('')).resolves.toBeNull();
  });
});
