/**
 * @jest-environment node
 *
 * The post-call review orchestrator.
 *
 * The tests are organised around the decisions that are expensive to get wrong, because that is where
 * the source carries scar tissue:
 *
 *  - The **four early exits** are not interchangeable. "Provider has no such conversation" FINALIZES the
 *    attempt; "transcript not ready yet" must NOT, and must never be read as a voicemail.
 *  - **Idempotency** on `call_id`. A re-fired review that re-evaluates engagement produced the
 *    Lost↔Engaged flapping in production, so the no-op is asserted to touch nothing.
 *  - **Opt-out mirroring** sets on opt-out and clears ONLY on an explicit opt-in. The absence case is
 *    tested directly: a prior opt-out has to survive a call that simply did not mention it.
 *  - **A demo is never a callback.** Booking, the harmonized channel-pref signals, and the suppressed
 *    callback are all asserted from the one outcome classification.
 *  - **The referral fork's two guards.** A false positive forks a duplicate chat AND stops the source's
 *    outreach, so DEMO WINS and DIFFERENT PERSON ONLY each get their own test.
 *  - **Engagement trusts hard signals** over the heuristic, and "no engagement" is disambiguated from
 *    "voicemail" rather than guessed.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../firebase/agent', () => ({ getAgent: jest.fn() }));
jest.mock('../../tools/reviewHelpers', () => {
  const actual = jest.requireActual('../../tools/reviewHelpers');
  return {
    ...actual,
    llmText: jest.fn(),
    resolveStageAndSkills: jest.fn(),
    extractFromTranscriptWithSchema: jest.fn(),
    detectChannelPreferences: jest.fn(),
    classifyCallOutcome: jest.fn(),
  };
});
jest.mock('../../tools/reviewActions', () => {
  const actual = jest.requireActual('../../tools/reviewActions');
  return {
    ...actual,
    classifyAnswerer: jest.fn(),
    hadMeaningfulEngagement: jest.fn(),
    llmDetectVoicemail: jest.fn(),
  };
});
jest.mock('../../services/conversationSummary', () => ({
  generateAndCacheSummary: jest.fn(),
}));
jest.mock('../../services/referralTransfer', () => ({
  handleReferralTransfer: jest.fn(),
}));
jest.mock('../../services/stalledRecovery', () => ({
  finalizeUnresolvedCall: jest.fn(),
}));

import { store } from '../../testSupport/mockFirestore';
import { getAgent } from '../../firebase/agent';
import {
  channelPrefSafeDefaults,
  classifyCallOutcome,
  detectChannelPreferences,
  extractFromTranscriptWithSchema,
  llmText,
  resolveStageAndSkills,
} from '../../tools/reviewHelpers';
import {
  classifyAnswerer,
  hadMeaningfulEngagement,
  llmDetectVoicemail,
} from '../../tools/reviewActions';
import { generateAndCacheSummary } from '../../services/conversationSummary';
import { handleReferralTransfer } from '../../services/referralTransfer';
import { finalizeUnresolvedCall } from '../../services/stalledRecovery';
import {
  formatElevenlabsTranscript,
  parseAndRunReviewCallTranscript,
} from '../../tools/reviewCallTranscript';
import type { CallInfo } from '../../tools/reviewCallTranscript';

const CHAT = 'outbound__agentA__15551230000';
const AGENT = 'agentA';
const CALL = 'conv_abc123';

const LIVE =
  'AI: Hi, is this Jane?\nHUMAN: Yes, speaking.\nAI: Can we book a demo?\nHUMAN: Thursday at ten works.';

/** Every result field the tool returns, unwrapped from the Bedrock toolResult envelope. */
function unwrap(msg: unknown): Record<string, unknown> {
  const content = (
    msg as {
      content: {
        toolResult: { content: { json: Record<string, unknown> }[] };
      }[];
    }
  ).content;
  return content[0].toolResult.content[0].json;
}

function callInfo(over: Partial<CallInfo> = {}): CallInfo {
  return {
    transcript: LIVE,
    analysis: { summary: 'A demo was agreed.' },
    recording_url: '',
    call_status: 'done',
    ...over,
  };
}

function seedChat(over: Record<string, unknown> = {}) {
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    stage: 'Contacted',
    phone_opt_out: false,
    memory: {
      agent_id: AGENT,
      phone_number: '15551230000',
      first_name: 'Jane',
      timezone: 'America/Denver',
      record_type: 'Test', // bypasses the business-hours clamp, keeping schedules deterministic
      ...((over.memory as Record<string, unknown>) ?? {}),
    },
    ...over,
  });
}

function chat(): Record<string, unknown> {
  return store.get(`chats/${CHAT}`) ?? {};
}

function memory(): Record<string, unknown> {
  return (chat().memory as Record<string, unknown>) ?? {};
}

function tasks(): Record<string, unknown>[] {
  return store
    .paths(`chats/${CHAT}/tasks`)
    .map((p) => store.get(p) as Record<string, unknown>);
}

/** Run the tool against a supplied transcript, with the ElevenLabs fetch stubbed out. */
async function review(
  info: CallInfo | null,
  opts: Record<string, unknown> = {},
  input: Record<string, unknown> = { call_id: CALL }
) {
  return unwrap(
    await parseAndRunReviewCallTranscript(CALL, input, {
      chatId: CHAT,
      metaData: { agent_id: AGENT, company_id: 'co1' },
      fetchCall: async () => info,
      ...opts,
    })
  );
}

const answerer = classifyAnswerer as jest.Mock;
const engagement = hadMeaningfulEngagement as jest.Mock;
const vmDetect = llmDetectVoicemail as jest.Mock;
const stageSkills = resolveStageAndSkills as jest.Mock;
const extract = extractFromTranscriptWithSchema as jest.Mock;
const channelPrefs = detectChannelPreferences as jest.Mock;
const outcome = classifyCallOutcome as jest.Mock;
const referral = handleReferralTransfer as jest.Mock;
const finalize = finalizeUnresolvedCall as jest.Mock;
const summary = generateAndCacheSummary as jest.Mock;

/** The neutral verdicts: a live human, nothing extracted, no preference signals, no commitment. */
function neutralVerdicts() {
  answerer.mockResolvedValue('human');
  engagement.mockResolvedValue(false);
  vmDetect.mockResolvedValue(false);
  stageSkills.mockResolvedValue(['Contacted', []]);
  extract.mockResolvedValue({});
  channelPrefs.mockResolvedValue(channelPrefSafeDefaults());
  outcome.mockResolvedValue({
    outcome: 'no_commitment',
    agreed_time: null,
    quote: null,
  });
  referral.mockResolvedValue({
    ok: true,
    new_chat_id: 'outbound__agentA__new',
  });
  summary.mockResolvedValue('a summary');
  (getAgent as jest.Mock).mockResolvedValue({
    voice_ai_provider: 'elevenlabs',
  });
  (llmText as jest.Mock).mockResolvedValue('{}');
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  neutralVerdicts();
  seedChat();
});

// ─────────────────────────────────────────────────────────────────────────────
// The transcript formatter
// ─────────────────────────────────────────────────────────────────────────────

describe('formatElevenlabsTranscript', () => {
  test('renders one line per turn so HUMAN turns stay countable', () => {
    expect(
      formatElevenlabsTranscript([
        { role: 'agent', message: 'Hi there' },
        { role: 'user', message: 'Hello' },
      ])
    ).toBe('AI: Hi there\nHUMAN: Hello');
  });

  test('skips tool turns, whose message is null', () => {
    expect(
      formatElevenlabsTranscript([
        { role: 'agent', message: 'One moment' },
        { role: 'agent', message: null, tool_calls: [{ name: 'lookup' }] },
        { role: 'user', message: 'Sure' },
      ])
    ).toBe('AI: One moment\nHUMAN: Sure');
  });

  test('maps every agent-ish role to AI and everything else to HUMAN', () => {
    expect(
      formatElevenlabsTranscript([
        { role: 'assistant', message: 'a' },
        { role: 'ai', message: 'b' },
        { role: 'unknown', message: 'c' },
      ])
    ).toBe('AI: a\nAI: b\nHUMAN: c');
  });

  test('an empty array yields the empty string, never a conclusion', () => {
    expect(formatElevenlabsTranscript([])).toBe('');
    expect(formatElevenlabsTranscript(null)).toBe('');
  });

  test('an empty MESSAGE is kept — only null means "not dialogue"', () => {
    expect(formatElevenlabsTranscript([{ role: 'user', message: '' }])).toBe(
      'HUMAN: '
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four early exits, and why they differ
// ─────────────────────────────────────────────────────────────────────────────

describe('early exits', () => {
  test('no call_id is a plain failure', async () => {
    const r = await review(callInfo(), {}, { call_id: '  ' });
    expect(r.status).toBe('failed');
    expect(r.message).toBe('call_id is required');
    expect(finalize).not.toHaveBeenCalled();
  });

  test('the provider having no such conversation is TERMINAL and finalizes the attempt', async () => {
    const r = await review(null);
    expect(r.status).toBe('failed');
    expect(r.message).toBe(`Call ${CALL} not found in elevenlabs`);
    expect(finalize).toHaveBeenCalledWith(CHAT, {
      callId: CALL,
      reason: 'transcript-not-found',
    });
  });

  test('an empty transcript is "still processing" — NOT terminal, and NOT a voicemail', async () => {
    const r = await review(callInfo({ transcript: '' }));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/still be processing/);
    expect(r.is_voicemail).toBeUndefined();
    // Crucially: the attempt is left alive so a later review can still succeed.
    expect(finalize).not.toHaveBeenCalled();
    expect(answerer).not.toHaveBeenCalled();
  });

  test('an unsupported provider reports the gap without finalizing a live call', async () => {
    (getAgent as jest.Mock).mockResolvedValue({ voice_ai_provider: 'vapi' });
    const r = await review(callInfo());
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/'vapi' is not available/);
    expect(finalize).not.toHaveBeenCalled();
  });

  test('a reviewed call_id is an idempotent no-op that changes NOTHING', async () => {
    seedChat({ memory: { _reviewed_call_ids: [CALL] } });
    const before = JSON.stringify(chat());
    const r = await review(callInfo());
    expect(r).toEqual({
      status: 'success',
      call_id: CALL,
      already_reviewed: true,
      message: 'This call was already reviewed; no changes re-applied.',
    });
    // The whole mutating pipeline is skipped — this is what stopped the Lost↔Engaged flapping.
    expect(answerer).not.toHaveBeenCalled();
    expect(channelPrefs).not.toHaveBeenCalled();
    expect(chat().stage).toBe('Contacted');
    expect(JSON.stringify(chat())).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The card-flip backstop
// ─────────────────────────────────────────────────────────────────────────────

describe('the in_progress card flip', () => {
  test('flips this call_id to completed even when the webhook never matched', async () => {
    store.set(`chats/${CHAT}/messages/m1`, {
      timestamp: new Date(),
      content: [
        {
          toolUse: {
            name: 'make_phone_call',
            input: { call_id: CALL },
            status: 'in_progress',
          },
        },
      ],
    });
    store.set(`chats/${CHAT}/activities/a1`, {
      toolCall: {
        toolName: 'make_phone_call',
        status: 'in_progress',
        result: { call_id: CALL, status: 'in_progress' },
      },
    });
    await review(callInfo({ summary: 'Spoke to Jane.' }));
    const tc = (store.get(`chats/${CHAT}/activities/a1`) ?? {})
      .toolCall as Record<string, unknown>;
    expect(tc.status).toBe('completed');
    expect((tc.result as Record<string, unknown>).summary).toBe(
      'Spoke to Jane.'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The engagement gate: no live human
// ─────────────────────────────────────────────────────────────────────────────

describe('no live human answered', () => {
  test('voicemail stamps the unanswered time and reports human_reached false', async () => {
    answerer.mockResolvedValue('voicemail');
    const r = await review(callInfo());
    expect(r.status).toBe('success');
    expect(r.human_reached).toBe(false);
    expect(r.is_voicemail).toBe(true);
    expect(r.is_ivr).toBe(false);
    expect(r.all_confirmed).toBe(false);
    expect(typeof memory()._last_call_unanswered_at).toBe('string');
    // No field analysis on this path at all.
    expect(extract).not.toHaveBeenCalled();
    expect(channelPrefs).not.toHaveBeenCalled();
  });

  test('an IVR is reported distinctly from a voicemail', async () => {
    answerer.mockResolvedValue('ivr');
    const r = await review(callInfo());
    expect(r.is_ivr).toBe(true);
    // An auto-attendant is not an answering machine, and the retry cadence branches on the difference.
    expect(r.is_voicemail).toBe(false);
    expect(String(r.summary)).toMatch(/auto-attendant/);
  });

  test('nobody speaking is reported as neither voicemail nor IVR', async () => {
    answerer.mockResolvedValue('none');
    const r = await review(callInfo());
    expect(r.is_voicemail).toBe(false);
    expect(r.is_ivr).toBe(false);
  });

  test('a no-answer summary is cached when there is none', async () => {
    answerer.mockResolvedValue('voicemail');
    await review(callInfo());
    expect(String(memory()._conversation_summary)).toMatch(
      /No live person reached/
    );
  });

  test('a no-answer summary NEVER clobbers a real-conversation summary', async () => {
    seedChat({
      memory: { _conversation_summary: 'Jane asked about pricing.' },
    });
    answerer.mockResolvedValue('voicemail');
    await review(callInfo());
    expect(memory()._conversation_summary).toBe('Jane asked about pricing.');
  });

  test('the call is still marked reviewed, so a re-fire cannot re-run it', async () => {
    answerer.mockResolvedValue('voicemail');
    await review(callInfo());
    expect(memory()._reviewed_call_ids).toEqual([CALL]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema extraction and the append-only email
// ─────────────────────────────────────────────────────────────────────────────

describe('schema extraction', () => {
  test('persists extracted fields under memory and reports the change', async () => {
    stageSkills.mockResolvedValue([
      'Contacted',
      [
        {
          memory_schema: { fleet_size: { type: 'number' } },
          instructions: 'x',
        },
      ],
    ]);
    extract.mockResolvedValue({ fleet_size: 12 });
    const r = await review(callInfo());
    expect(memory().fleet_size).toBe(12);
    expect(r.confirmed_fields).toEqual(['fleet_size']);
    expect(r.memory_changes).toContain(
      "fleet_size: '' -> '12' (schema extraction)"
    );
  });

  test('no memory_schema on the active skills skips extraction entirely', async () => {
    stageSkills.mockResolvedValue([
      'Contacted',
      [{ instructions: 'no schema here' }],
    ]);
    await review(callInfo());
    expect(extract).not.toHaveBeenCalled();
  });

  test('a new customer_email becomes active and the PRIOR address is kept in history', async () => {
    seedChat({ memory: { customer_email: 'old@corp.com' } });
    stageSkills.mockResolvedValue([
      'Contacted',
      [{ memory_schema: { customer_email: { type: 'string' } } }],
    ]);
    extract.mockResolvedValue({ customer_email: 'new@corp.com' });
    await review(callInfo());
    expect(memory().customer_email).toBe('new@corp.com');
    expect(memory()._email_history).toEqual(['old@corp.com']);
  });

  test('the same address re-extracted rewrites nothing', async () => {
    seedChat({ memory: { customer_email: 'same@corp.com' } });
    stageSkills.mockResolvedValue([
      'Contacted',
      [{ memory_schema: { customer_email: { type: 'string' } } }],
    ]);
    extract.mockResolvedValue({ customer_email: 'same@corp.com' });
    await review(callInfo());
    expect(memory().customer_email).toBe('same@corp.com');
    expect(memory()._email_history).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out mirroring
// ─────────────────────────────────────────────────────────────────────────────

describe('opt-out mirroring to the trustworthy top-level keys', () => {
  test('a detected phone opt-out sets the top-level gate key', async () => {
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      phone_opt_out: true,
    });
    await review(callInfo());
    expect(chat().phone_opt_out).toBe(true);
    expect(memory().block_phone).toBe('Y');
  });

  test('only an EXPLICIT opt-in clears it', async () => {
    seedChat({ phone_opt_out: true, memory: { block_phone: 'Y' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      phone_opt_in: true,
    });
    await review(callInfo());
    expect(chat().phone_opt_out).toBe(false);
    expect(memory().block_phone).toBe('N');
  });

  test('ABSENCE of any signal leaves a prior opt-out standing', async () => {
    seedChat({ phone_opt_out: true, sms_opt_out: true });
    // The safe defaults: every flag false. Neither branch fires, so neither key is rewritten.
    await review(callInfo());
    expect(chat().phone_opt_out).toBe(true);
    expect(chat().sms_opt_out).toBe(true);
  });

  test('an SMS opt-in during the call reverses a prior SMS opt-out', async () => {
    seedChat({ memory: { sms_opt_out: 'Y' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      sms_opt_in: true,
    });
    const r = await review(callInfo());
    expect(memory().sms_opt_out).toBe('N');
    expect(chat().sms_opt_out).toBe(false);
    expect(r.sms_opt_in_detected).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Not interested
// ─────────────────────────────────────────────────────────────────────────────

describe('a declined deal', () => {
  test('labels the chat without touching the stage or any opt-out flag', async () => {
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      customer_sentiment: 'not_interested',
    });
    const r = await review(callInfo());
    expect(chat().labels).toContain('not_interested');
    // A decline is not an opt-out and not a stage change.
    expect(chat().phone_opt_out).toBe(false);
    expect(r.memory_changes).toContain(
      'not_interested label added + proactive outreach stopped (customer declined)'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A demo is never a callback
// ─────────────────────────────────────────────────────────────────────────────

describe('a demo outcome', () => {
  const DEMO = {
    outcome: 'demo',
    agreed_time: '2026-08-06T10:00:00',
    quote: 'Thursday at ten works',
  };

  test('schedules a book_meeting task even with no slot matcher available', async () => {
    outcome.mockResolvedValue(DEMO);
    const r = await review(callInfo());
    expect(r.booking_task_created).toBe(true);
    expect(r.agreed_slot).toBeNull();
    const t = tasks().find((x) => x.type === 'book_meeting');
    // Never downgraded to a callback: the booking turn resolves the exact time live.
    expect(t).toBeDefined();
    expect((t!.data as Record<string, unknown>).task_source).toBe(
      'book_after_call_unmatched'
    );
  });

  test('a matched slot is reported and the fallback task is NOT written', async () => {
    outcome.mockResolvedValue(DEMO);
    const resolveBookingSlot = jest.fn().mockResolvedValue({
      resolved: true,
      label: 'Thursday 2026-08-06 at 10:00 AM',
      start_time_ms: 1_770_000_000_000,
    });
    const r = await review(callInfo(), { resolveBookingSlot });
    expect(r.agreed_slot).toBe('Thursday 2026-08-06 at 10:00 AM');
    expect(resolveBookingSlot).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, agreedTime: DEMO.agreed_time })
    );
    expect(tasks().some((x) => x.type === 'book_meeting')).toBe(false);
  });

  test('an unresolved match still books — the demo is never downgraded', async () => {
    outcome.mockResolvedValue(DEMO);
    const resolveBookingSlot = jest
      .fn()
      .mockResolvedValue({ resolved: false, label: null, start_time_ms: null });
    const r = await review(callInfo(), { resolveBookingSlot });
    expect(r.booking_task_created).toBe(true);
    expect(tasks().some((x) => x.type === 'book_meeting')).toBe(true);
    expect(r.follow_up_scheduled).toBeUndefined();
  });

  test('the review turn is told NOT to send the confirmation email itself', async () => {
    outcome.mockResolvedValue(DEMO);
    const r = await review(callInfo());
    expect(r.do_not_email_now).toBe(true);
    expect(r.confirmation_email).toBe('handled_by_book_meeting_task');
    expect(String(r.next_step_note)).toMatch(/schedule_hubspot_meeting/);
  });

  test('callback-flavoured channel-pref signals are OVERWRITTEN', async () => {
    outcome.mockResolvedValue(DEMO);
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      customer_requested_call: true,
      conversation_status: 'deferred',
      ending_reason: 'customer_asked_callback',
      deferred_until: '2026-08-06T10:00:00',
    });
    const r = await review(callInfo());
    const prefs = r.channel_preferences as Record<string, unknown>;
    const ctx = r.conversation_context as Record<string, unknown>;
    expect(prefs.customer_requested_call).toBe(false);
    expect(ctx.conversation_status).toBe('scheduled');
    expect(ctx.ending_reason).toBe('demo_scheduled');
    expect(ctx.deferred_until).toBeNull();
    // And the persisted callback signal stays off, so the hot-prospect check cannot re-dial.
    expect(memory()._customer_wants_callback).toBe(false);
    expect(r.customer_wants_callback).toBe(false);
  });

  test('pending proactive outreach is purged so a booked prospect is not cold-called', async () => {
    outcome.mockResolvedValue(DEMO);
    store.set(`chats/${CHAT}/tasks/t_stale`, {
      type: 'outbound_outreach',
      executed: false,
      data: {},
    });
    await review(callInfo());
    expect(tasks().some((x) => x.type === 'outbound_outreach')).toBe(false);
  });

  test('a prior unexecuted book_meeting task is deduped, never doubled', async () => {
    outcome.mockResolvedValue(DEMO);
    store.set(`chats/${CHAT}/tasks/t_old_book`, {
      type: 'book_meeting',
      executed: false,
      data: { task_source: 'earlier' },
    });
    await review(callInfo());
    const books = tasks().filter((x) => x.type === 'book_meeting');
    expect(books).toHaveLength(1);
    expect((books[0].data as Record<string, unknown>).task_source).toBe(
      'book_after_call_unmatched'
    );
  });

  test('a demo is engaged BY DEFINITION when the slot resolved', async () => {
    outcome.mockResolvedValue(DEMO);
    const resolveBookingSlot = jest
      .fn()
      .mockResolvedValue({ resolved: true, label: 'L', start_time_ms: 1 });
    // The heuristic says no — the hard signal must win.
    engagement.mockResolvedValue(false);
    await review(callInfo(), { resolveBookingSlot });
    expect(chat().stage).toBe('Engaged');
    expect(engagement).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Callbacks
// ─────────────────────────────────────────────────────────────────────────────

describe('a callback outcome', () => {
  const CALLBACK = {
    outcome: 'callback',
    agreed_time: '2026-08-03T14:00:00',
    quote: 'call me Monday',
  };

  test('schedules a callback and never books or Leads', async () => {
    outcome.mockResolvedValue(CALLBACK);
    const r = await review(callInfo());
    expect(r.follow_up_scheduled).toBe('callback');
    expect(r.booking_task_created).toBeUndefined();
    expect(tasks().some((x) => x.type === 'book_meeting')).toBe(false);
    expect(r.customer_wants_callback).toBe(true);
    expect(r.callback_time).toBe(CALLBACK.agreed_time);
    expect(memory()._customer_wants_callback).toBe(true);
  });

  test('a scheduled callback IS the touch, so no voicemail guess is made', async () => {
    outcome.mockResolvedValue(CALLBACK);
    engagement.mockResolvedValue(false);
    const r = await review(callInfo());
    expect(r.human_reached).toBe(false);
    expect(r.is_voicemail).toBe(false);
    expect(r.low_engagement).toBe(false);
    expect(vmDetect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The referral fork's two hard guards
// ─────────────────────────────────────────────────────────────────────────────

describe('the referral fork', () => {
  const REF = {
    is_referral: true,
    referred_first_name: 'Bob',
    referred_last_name: 'Jones',
    referred_email: 'bob@corp.com',
    referred_phone: null,
    referred_title: 'Ops',
    referrer_name: 'Jane',
  };

  test('a different person forks a new warm chat', async () => {
    seedChat({ memory: { customer_email: 'jane@corp.com' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      referral: REF,
    });
    const r = await review(callInfo());
    expect(referral).toHaveBeenCalledWith(CHAT, REF, {
      referrer: 'Jane',
      source: 'review_call',
    });
    expect(String((r.memory_changes as string[]).join())).toMatch(
      /referral transfer → new chat/
    );
  });

  test('DEMO WINS — a referral signal co-firing with a demo never forks', async () => {
    seedChat({ memory: { customer_email: 'jane@corp.com' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      referral: REF,
    });
    outcome.mockResolvedValue({
      outcome: 'demo',
      agreed_time: '2026-08-06T10:00:00',
      quote: 'q',
    });
    const r = await review(callInfo());
    expect(referral).not.toHaveBeenCalled();
    expect((r.memory_changes as string[]).join()).toMatch(
      /referral signal ignored \(demo booked on this chat\)/
    );
  });

  test('DIFFERENT PERSON ONLY — the prospect giving their own address never forks', async () => {
    seedChat({ memory: { customer_email: 'BOB@corp.com' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      referral: REF,
    });
    const r = await review(callInfo());
    // Case-insensitive: "email me at my other address" is an email update, not a referral.
    expect(referral).not.toHaveBeenCalled();
    expect((r.memory_changes as string[]).join()).toMatch(/same person/);
  });

  test("the address given on THIS call counts as the prospect's own", async () => {
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      referral: REF,
      followup_email: 'bob@corp.com',
    });
    await review(callInfo());
    expect(referral).not.toHaveBeenCalled();
  });

  test('a referred PHONE that differs is enough to fork', async () => {
    seedChat({ memory: { phone_number: '15551230000' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      referral: {
        ...REF,
        referred_email: null,
        referred_phone: '+1 (555) 999-8888',
      },
    });
    await review(callInfo());
    expect(referral).toHaveBeenCalled();
  });

  test('a referral naming the prospect’s OWN phone does not fork', async () => {
    seedChat({ memory: { phone_number: '15551230000' } });
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      referral: {
        ...REF,
        referred_email: null,
        referred_phone: '+1 (555) 123-0000',
      },
    });
    await review(callInfo());
    expect(referral).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The follow-up email
// ─────────────────────────────────────────────────────────────────────────────

describe('the follow-up email', () => {
  function withFollowup(extra: Record<string, unknown> = {}) {
    channelPrefs.mockResolvedValue({
      ...channelPrefSafeDefaults(),
      followup_email: 'ops@corp.com',
      ...extra,
    });
  }

  test('schedules an email task when an address was agreed on the call', async () => {
    withFollowup();
    const r = await review(callInfo());
    expect(r.follow_up_scheduled).toBe('followup_email');
    expect(r.followup_email).toBe('ops@corp.com');
  });

  test('a phone-lane chat is CALL-ONLY — no proactive follow-up email', async () => {
    seedChat({ memory: { _outreach_lane: 'phone' } });
    withFollowup();
    const r = await review(callInfo());
    expect(r.follow_up_scheduled).toBeUndefined();
    expect(tasks().some((x) => x.type === 'followup_email')).toBe(false);
  });

  test('a forked referral skips it — the new chat owns the outreach', async () => {
    seedChat({ memory: { customer_email: 'jane@corp.com' } });
    withFollowup({
      referral: {
        is_referral: true,
        referred_first_name: 'Bob',
        referred_last_name: null,
        referred_email: 'bob@corp.com',
        referred_phone: null,
        referred_title: null,
        referrer_name: 'Jane',
      },
    });
    const r = await review(callInfo());
    expect(referral).toHaveBeenCalled();
    expect(r.followup_email).toBeUndefined();
  });

  test('a callback keeps its label — a gatekeeper can give BOTH', async () => {
    withFollowup();
    outcome.mockResolvedValue({
      outcome: 'callback',
      agreed_time: '2026-08-03T14:00:00',
      quote: 'q',
    });
    const r = await review(callInfo());
    // The callback is the primary label; the email is still scheduled alongside it.
    expect(r.follow_up_scheduled).toBe('callback');
    expect(r.followup_email).toBe('ops@corp.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Engagement
// ─────────────────────────────────────────────────────────────────────────────

describe('advancing to Engaged', () => {
  test('captured schema fields are a hard signal — the heuristic is not consulted', async () => {
    stageSkills.mockResolvedValue([
      'Contacted',
      [{ memory_schema: { fleet_size: { type: 'number' } } }],
    ]);
    extract.mockResolvedValue({ fleet_size: 4 });
    engagement.mockResolvedValue(false);
    const r = await review(callInfo());
    expect(chat().stage).toBe('Engaged');
    expect(r.human_reached).toBe(true);
    expect(engagement).not.toHaveBeenCalled();
  });

  test('with no hard signal the heuristic decides, and a yes advances', async () => {
    engagement.mockResolvedValue(true);
    await review(callInfo());
    expect(engagement).toHaveBeenCalled();
    expect(chat().stage).toBe('Engaged');
  });

  test('engaging resets the follow-up counters and reopens the cadence', async () => {
    seedChat({
      cadence_complete: true,
      email_followup_count: 2,
      call_followup_count: 3,
    });
    engagement.mockResolvedValue(true);
    await review(callInfo());
    expect(chat().email_followup_count).toBe(0);
    expect(chat().call_followup_count).toBe(0);
    expect(chat().cadence_complete).toBe(false);
  });

  test('a positive phone engagement FOCUSES the phone lane for a test record', async () => {
    seedChat({
      email_fallback_available: true,
      memory: { _email_fallback_available: true },
    });
    engagement.mockResolvedValue(true);
    await review(callInfo());
    expect(memory()._email_fallback_available).toBe(false);
    expect(chat().email_fallback_available).toBe(false);
  });

  test('no engagement plus a voicemail verdict keeps the retry cadence', async () => {
    engagement.mockResolvedValue(false);
    vmDetect.mockResolvedValue(true);
    const r = await review(callInfo());
    expect(r.human_reached).toBe(false);
    expect(r.is_voicemail).toBe(true);
    expect(r.low_engagement).toBe(false);
    expect(chat().stage).toBe('Contacted');
  });

  test('no engagement and NOT a voicemail is low_engagement — no rapid re-dial', async () => {
    engagement.mockResolvedValue(false);
    vmDetect.mockResolvedValue(false);
    const r = await review(callInfo());
    expect(r.low_engagement).toBe(true);
    expect(r.is_voicemail).toBe(false);
    expect(typeof r.voice_attempts === 'number').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wrap-up
// ─────────────────────────────────────────────────────────────────────────────

describe('completing the review', () => {
  test('marks the call reviewed so a duplicate cannot re-run the pipeline', async () => {
    await review(callInfo());
    expect(memory()._reviewed_call_ids).toEqual([CALL]);
    expect(typeof memory()._last_call_reviewed_at).toBe('string');
  });

  test('caches a voice-call summary with the extracted fields', async () => {
    stageSkills.mockResolvedValue([
      'Contacted',
      [{ memory_schema: { fleet_size: { type: 'number' } } }],
    ]);
    extract.mockResolvedValue({ fleet_size: 9 });
    await review(callInfo());
    expect(summary).toHaveBeenCalledWith(
      CHAT,
      LIVE,
      { fleet_size: 9 },
      expect.any(Object),
      'voice_call',
      expect.any(Object)
    );
  });

  test('records the voice touch so later turns can reason about recency', async () => {
    await review(callInfo());
    expect(memory()._last_channel).toBe('voice');
    expect(typeof memory()._last_touch_at).toBe('string');
  });

  test('a mid-pipeline throw is reported without losing the computed result', async () => {
    // The channel-pref write is inside the pipeline; a summary failure must stay non-blocking.
    summary.mockRejectedValue(new Error('llm down'));
    const r = await review(callInfo());
    expect(r.status).toBe('success');
    expect(r.message).toBeUndefined();
  });
});
