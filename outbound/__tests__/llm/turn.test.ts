/**
 * @jest-environment node
 *
 * The outbound turn entry.
 *
 * The properties that matter here are the ones whose failures are silent:
 *
 *  - **Only a HUMAN `@ai` trigger overrides timing.** An automated one firing "immediately" is how a
 *    scheduler stampedes, so the cron's trigger must never claim that authority.
 *  - **The rapid-status lock is cleared on EVERY exit path.** A leaked `true` queues every future
 *    message for that chat and it goes quiet with no error anywhere.
 *  - **The AVAILABILITY block is computed, not delegated.** The no-answer 24h window and the
 *    authoritative STATUS line exist because a model gets time arithmetic wrong and re-reads its own
 *    stale "cannot be reactivated" text.
 *  - **An outbound chat discards its base prompt**, so the lead context has to be re-injected after
 *    skills or the agent never learns who it is contacting.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../llm/run', () => ({ withTools: jest.fn() }));
jest.mock('../../services/skillsResolver', () => {
  const actual = jest.requireActual('../../services/skillsResolver');
  return { ...actual, resolveStageAndSkills: jest.fn() };
});

import { store } from '../../testSupport/mockFirestore';
import { withTools } from '../../llm/run';
import { resolveStageAndSkills } from '../../services/skillsResolver';
import {
  buildOutboundContextBlocks,
  checkMention,
  runOutboundLlm,
  runOutboundTurn,
  __testing as t,
} from '../../llm/turn';
import type { ChatMemory } from '../../types';

const turnLoop = withTools as jest.Mock;
const skills = resolveStageAndSkills as jest.Mock;

const CHAT = 'outbound__agentA__15551230000';
const AGENT = 'agentA';

function seedAgent(over: Record<string, unknown> = {}) {
  store.set(`agents/${AGENT}`, {
    persona: 'You are Nova.',
    prompt: 'Book demos.',
    guardrails: 'Be polite.',
    additional_instructions: '',
    ...over,
  });
  // Enabled functions come from the agent's `actions` SUBCOLLECTION — and each entry must be
  // `status: 'active'` AND point at a shared `actions/{id}` doc that holds the function list. My first
  // fixture invented a field on the agent doc that nothing reads.
  store.set(`agents/${AGENT}/actions/a1`, {
    status: 'active',
    action_id: 'act_email_voice',
  });
  store.set('actions/act_email_voice', {
    type: 'outbound',
    action_prompt: '',
    functions: ['send_email', 'make_phone_call'],
  });
}

function seedChat(over: Record<string, unknown> = {}) {
  const { memory: memOver, ...rest } = over;
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    stage: 'Contacted',
    ...rest,
    memory: {
      agent_id: AGENT,
      first_name: 'Jane',
      phone_number: '15551230000',
      customer_email: 'jane@corp.com',
      ...((memOver as Record<string, unknown>) ?? {}),
    },
  });
}

function mem(over: ChatMemory = {}): ChatMemory {
  return {
    first_name: 'Jane',
    phone_number: '15551230000',
    customer_email: 'jane@corp.com',
    ...over,
  };
}

/** The system prompt the dispatch loop was handed. */
function promptSent(): string {
  return String(turnLoop.mock.calls[0][0].systemPrompt);
}

/** The meta the dispatch loop was handed. */
function metaSent(): Record<string, unknown> {
  return turnLoop.mock.calls[0][0].metaData as Record<string, unknown>;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  turnLoop.mockResolvedValue([
    [{ role: 'assistant', content: [{ text: 'Done' }] }],
    { tools: {}, tokens: { input: 1, output: 1 } },
  ]);
  skills.mockResolvedValue({
    stage: 'Contacted',
    activeSkills: [],
    labels: [],
    chatMemory: {},
  });
  seedAgent();
  seedChat();
});

// ─────────────────────────────────────────────────────────────────────────────
// Mention detection and trigger authority
// ─────────────────────────────────────────────────────────────────────────────

describe('checkMention', () => {
  test('matches @ai and @atlas anywhere, case-insensitively', () => {
    expect(checkMention('@ai call now')).toBe(true);
    expect(checkMention('hey @Atlas please follow up')).toBe(true);
    expect(checkMention('@AI')).toBe(true);
  });

  test('an ordinary customer message is not a mention', () => {
    expect(checkMention('sounds good, thanks')).toBe(false);
    expect(checkMention('')).toBe(false);
    expect(checkMention(null)).toBe(false);
  });

  test('a bare "ai" inside a word does NOT match — the @ is required', () => {
    expect(checkMention('please email me the details')).toBe(false);
    expect(checkMention('my name is Aisha')).toBe(false);
  });
});

describe('trigger authority', () => {
  test('a HUMAN @ai trigger is authoritative on timing', () => {
    const c = t.resolveTriggerContext('@ai call her now', 'human');
    expect(c.adminTrigger).toBe(true);
    expect(c.adminOverride).toBe(true);
  });

  test('"asap" and friends force immediate action — but only for a human', () => {
    for (const word of ['asap', 'immediately', 'right away', 'right now']) {
      expect(
        t.resolveTriggerContext(`@ai call her ${word}`, 'human').adminAsap
      ).toBe(true);
    }
    // The cron says the same words and gets no authority: an automated trigger firing
    // "immediately" is how a scheduler stampedes.
    const internal = t.resolveTriggerContext('@ai call her asap', 'internal');
    expect(internal.adminTrigger).toBe(true);
    expect(internal.adminOverride).toBe(false);
    expect(internal.adminAsap).toBe(false);
  });

  test('a human @ai without urgency words overrides delays but does not fire now', () => {
    const c = t.resolveTriggerContext('@ai call her on Tuesday', 'human');
    expect(c.adminOverride).toBe(true);
    expect(c.adminAsap).toBe(false);
  });

  test('a customer message carries no admin flags at all', () => {
    const c = t.resolveTriggerContext('thanks, talk soon', 'human');
    expect(c.adminTrigger).toBe(false);
    expect(c.adminOverride).toBe(false);
    expect(c.messageFrom).toBe('customer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The AVAILABILITY block
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOutboundContextBlocks', () => {
  test('lists the lead fields it has, and omits the ones it does not', () => {
    const b = buildOutboundContextBlocks(
      mem({ company: 'Acme' }),
      'Contacted',
      'customer',
      'hi'
    );
    expect(b).toContain('- Name: Jane');
    expect(b).toContain('- Company: Acme');
    expect(b).not.toContain('- Last name:');
  });

  test('states channel reachability from the opt-out flags', () => {
    const open = buildOutboundContextBlocks(mem(), 'Contacted', 'customer', '');
    expect(open).toContain('- phone: reachable');
    expect(open).toContain('- email: reachable');

    const closed = buildOutboundContextBlocks(
      mem({ block_phone: 'Y', _email_opt_out: true }),
      'Contacted',
      'customer',
      ''
    );
    expect(closed).toContain('- phone: opted out (do not call)');
    expect(closed).toContain('- email: opted out (do not email)');
  });

  test('a missing channel reads "none on file", not "reachable"', () => {
    const b = buildOutboundContextBlocks(
      mem({ phone_number: '', customer_email: '' }),
      'New',
      'customer',
      ''
    );
    expect(b).toContain('- phone: none on file');
    expect(b).toContain('- email: none on file');
  });

  test('CHANNEL PRIORITY appears only when BOTH channels are open', () => {
    // Stated deterministically because a model with both open defaults to email.
    expect(
      buildOutboundContextBlocks(mem(), 'Contacted', 'customer', '')
    ).toContain('CHANNEL PRIORITY');
    expect(
      buildOutboundContextBlocks(
        mem({ phone_opt_out: 'Y' }),
        'Contacted',
        'customer',
        ''
      )
    ).not.toContain('CHANNEL PRIORITY');
  });

  test('the no-answer email is ALLOWED only inside the 24h window', () => {
    // Computed here because models are unreliable at "within 24 hours".
    const fresh = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      buildOutboundContextBlocks(
        mem({ _last_call_unanswered_at: fresh }),
        'Contacted',
        'customer',
        ''
      )
    ).toContain('- no-answer email: ALLOWED');

    const stale = new Date(Date.now() - 30 * 3_600_000).toISOString();
    expect(
      buildOutboundContextBlocks(
        mem({ _last_call_unanswered_at: stale }),
        'Contacted',
        'customer',
        ''
      )
    ).toContain('- no-answer email: NOT ALLOWED');
  });

  test('with no unanswered call on record it is NOT ALLOWED', () => {
    expect(
      buildOutboundContextBlocks(mem(), 'Contacted', 'customer', '')
    ).toContain('- no-answer email: NOT ALLOWED');
  });

  test('an unparseable timestamp fails CLOSED — no email on a bad read', () => {
    expect(
      t.noAnswerWindowFresh(mem({ _last_call_unanswered_at: 'garbage' }))
    ).toBe(false);
  });

  test('the no-answer line is omitted entirely when phone is closed', () => {
    // An email-only prospect has no call to tie a "couldn't reach you" email to.
    const b = buildOutboundContextBlocks(
      mem({ phone_number: '' }),
      'Contacted',
      'customer',
      ''
    );
    expect(b).not.toContain('no-answer email');
  });

  test('the authoritative STATUS line overrides stale transcript text', () => {
    const b = buildOutboundContextBlocks(mem(), 'Contacted', 'customer', '');
    // A prospect can be reopened by ops, but the history is never rewritten.
    expect(b).toContain('- STATUS: this prospect is ACTIVE at stage Contacted');
    expect(b).toContain('it is stale; disregard it');
  });

  test('a LOST prospect gets no ACTIVE status line', () => {
    expect(
      buildOutboundContextBlocks(mem(), 'Lost', 'customer', '')
    ).not.toContain('STATUS: this prospect is ACTIVE');
  });

  test('a fully unreachable prospect gets no status line either', () => {
    expect(
      buildOutboundContextBlocks(
        mem({ phone_number: '', customer_email: '' }),
        'Contacted',
        'customer',
        ''
      )
    ).not.toContain('STATUS: this prospect is ACTIVE');
  });

  test('the follow-up counts carry the anchors the cadence needs', () => {
    const b = buildOutboundContextBlocks(
      mem({
        email_followup_count: 2,
        call_followup_count: 1,
        _first_outbound_email_at: '2026-08-01T10:00:00Z',
      }),
      'Contacted',
      'customer',
      ''
    );
    expect(b).toContain('email: 2 of 4, call: 1');
    expect(b).toContain('First email: 2026-08-01T10:00:00Z');
    expect(b).toContain('First call: not placed yet');
  });

  test('a callback request and the last touch are surfaced', () => {
    const b = buildOutboundContextBlocks(
      mem({
        _customer_wants_callback: true,
        _callback_time: '2026-08-05T14:00:00',
        _last_channel: 'voice',
        _last_touch_at: '2026-08-01T09:00:00Z',
      }),
      'Contacted',
      'customer',
      ''
    );
    expect(b).toContain(
      '- customer requested a callback at 2026-08-05T14:00:00'
    );
    expect(b).toContain('- last touch: voice at 2026-08-01T09:00:00Z');
  });

  test('an SMS opt-out is stated', () => {
    expect(
      buildOutboundContextBlocks(
        mem({ sms_opt_out: 'Y' }),
        'Contacted',
        'customer',
        ''
      )
    ).toContain('- SMS: opted out (do-not-SMS)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Running a turn
// ─────────────────────────────────────────────────────────────────────────────

describe('runOutboundTurn', () => {
  test('runs the loop and persists only the new entries', async () => {
    const r = await runOutboundTurn({
      message: 'hello',
      agentId: AGENT,
      chatId: CHAT,
    });
    expect(r.status).toBe(200);
    expect(r.entries).toHaveLength(1);
    expect(turnLoop).toHaveBeenCalledTimes(1);
    // The turn's messages landed in the chat.
    expect(store.paths(`chats/${CHAT}/messages`).length).toBeGreaterThan(0);
  });

  test('missing input is a 400 and never starts a turn', async () => {
    const r = await runOutboundTurn({
      message: '',
      agentId: AGENT,
      chatId: CHAT,
    });
    expect(r.status).toBe(400);
    expect(String(r.error)).toContain('message');
    expect(turnLoop).not.toHaveBeenCalled();
  });

  test('an unknown agent is a 400', async () => {
    store.reset();
    seedChat();
    const r = await runOutboundTurn({
      message: 'hi',
      agentId: 'nope',
      chatId: CHAT,
    });
    expect(r.status).toBe(400);
    expect(turnLoop).not.toHaveBeenCalled();
  });

  test('a turn already running QUEUES the message instead of racing it', async () => {
    store.set(`chats/${CHAT}/rapid_status/status`, { active: true });
    // Drive the real guard through its own store shape.
    const { setRapidStatus } = jest.requireActual('../../firebase/chat');
    await setRapidStatus(CHAT, true);
    const r = await runOutboundTurn({
      message: 'second message',
      agentId: AGENT,
      chatId: CHAT,
    });
    expect(r.status).toBe(202);
    expect(r.queued).toBe(true);
    // A second concurrent turn would interleave writes against the same history.
    expect(turnLoop).not.toHaveBeenCalled();
  });

  test('the lock is CLEARED after a successful turn', async () => {
    await runOutboundTurn({ message: 'hi', agentId: AGENT, chatId: CHAT });
    const { getRapidStatus } = jest.requireActual('../../firebase/chat');
    expect(await getRapidStatus(CHAT)).toBe(false);
  });

  test('the lock is CLEARED even when the turn THROWS', async () => {
    // A leaked lock queues every future message and the chat goes quiet with no error anywhere.
    turnLoop.mockRejectedValue(new Error('model exploded'));
    const r = await runOutboundTurn({
      message: 'hi',
      agentId: AGENT,
      chatId: CHAT,
    });
    expect(r.status).toBe(500);
    const { getRapidStatus } = jest.requireActual('../../firebase/chat');
    expect(await getRapidStatus(CHAT)).toBe(false);
  });

  test('an undefined loop result persists nothing but still succeeds', async () => {
    // withTools returns undefined on an unexpected stop reason.
    turnLoop.mockResolvedValue(undefined);
    const r = await runOutboundTurn({
      message: 'hi',
      agentId: AGENT,
      chatId: CHAT,
    });
    expect(r.status).toBe(200);
    expect(r.entries).toEqual([]);
    expect(store.paths(`chats/${CHAT}/messages`)).toHaveLength(0);
  });

  test('the assembled prompt carries the agent sections and the message context', async () => {
    await runOutboundTurn({ message: 'hi', agentId: AGENT, chatId: CHAT });
    const p = promptSent();
    expect(p).toContain('PERSONA OF AI AGENT');
    expect(p).toContain('You are Nova.');
    expect(p).toContain('ROLES AND RESPONSIBILITIES');
    // The channel preamble is prepended.
    expect(p).toContain('You received the message on WhatsApp');
  });

  test('an @ai turn is marked as an admin trigger for the loop', async () => {
    await runOutboundTurn({
      // "right now" — a bare "now" is deliberately NOT in the source's urgency list, so my first
      // version of this test asserted asap on a message the source would not have matched either.
      message: '@ai call her right now',
      agentId: AGENT,
      chatId: CHAT,
      adminTriggerSource: 'human',
    });
    const m = metaSent();
    // The loop reads is_admin_trigger for the short-circuit; the tools read the other two.
    expect(m.is_admin_trigger).toBe(true);
    expect(m.admin_override).toBe(true);
    expect(m.admin_asap).toBe(true);
    expect(String(promptSent())).toContain('message from ADMIN');
  });

  test('the enabled functions and model reach the loop', async () => {
    seedAgent({ assigned_model: 'claude-sonnet-4', company_id: 'co1' });
    await runOutboundTurn({ message: 'hi', agentId: AGENT, chatId: CHAT });
    const m = metaSent();
    expect(m.enabled_functions).toEqual(['send_email', 'make_phone_call']);
    expect(m.assigned_model).toBe('claude-sonnet-4');
    expect(m.company_id).toBe('co1');
    expect(m.chat_id).toBe(CHAT);
  });

  test('an OUTBOUND chat with skills gets the lead context injected after them', async () => {
    skills.mockResolvedValue({
      stage: 'Contacted',
      // `type: 'outbound'` is required — applySkillsToPrompt SKIPS an untyped skill on an outbound
      // chat (untyped means inbound-only). My first fixture omitted it and the skill vanished.
      activeSkills: [
        {
          name: 'day0',
          type: 'outbound',
          instructions: 'SKILL BODY: book a demo',
        },
      ],
      labels: [],
      chatMemory: {},
    });
    await runOutboundTurn({ message: 'hi', agentId: AGENT, chatId: CHAT });
    const p = promptSent();
    // The skill text replaced the base prompt, so the lead details must be re-injected or the agent
    // never learns who it is contacting.
    expect(p).toContain('SKILL BODY: book a demo');
    expect(p).toContain('OUTBOUND LEAD CONTEXT:');
    expect(p).toContain('AVAILABILITY & SIGNALS');
    expect(p).not.toContain('ROLES AND RESPONSIBILITIES');
  });

  test('a cached conversation summary is prepended for cross-channel context', async () => {
    seedChat({ memory: { _conversation_summary: 'Asked about pricing.' } });
    skills.mockResolvedValue({
      stage: 'Contacted',
      activeSkills: [{ name: 's', type: 'outbound', instructions: 'BODY' }],
      labels: [],
      chatMemory: {},
    });
    await runOutboundTurn({ message: 'hi', agentId: AGENT, chatId: CHAT });
    expect(promptSent()).toContain(
      'CONTEXT FROM PRIOR INTERACTIONS:\nAsked about pricing.'
    );
  });

  test('a skills failure does not take the turn down', async () => {
    skills.mockRejectedValue(new Error('skills unavailable'));
    const r = await runOutboundTurn({
      message: 'hi',
      agentId: AGENT,
      chatId: CHAT,
    });
    expect(r.status).toBe(200);
    // The base prompt still went to the model.
    expect(promptSent()).toContain('PERSONA OF AI AGENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The cron entry point
// ─────────────────────────────────────────────────────────────────────────────

describe('runOutboundLlm', () => {
  test('marks the trigger INTERNAL, so a scheduled @ai cannot claim human authority', async () => {
    await runOutboundLlm('@ai place the call asap', AGENT, CHAT);
    const m = metaSent();
    expect(m.is_admin_trigger).toBe(true);
    // The words are there; the authority is not.
    expect(m.admin_override).toBe(false);
    expect(m.admin_asap).toBe(false);
  });

  test('matches the cron’s TurnRunner shape', async () => {
    const r = await runOutboundLlm('do the thing', AGENT, CHAT);
    expect(r.status).toBe(200);
    expect(turnLoop).toHaveBeenCalledTimes(1);
  });
});
