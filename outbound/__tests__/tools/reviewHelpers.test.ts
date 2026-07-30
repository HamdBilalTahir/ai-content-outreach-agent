/**
 * @jest-environment node
 *
 * The LLM-analysis toolkit, and the email review's four intent checks that were waiting on it.
 *
 * Every function here fails toward the CONSERVATIVE answer, and each direction is chosen for its own
 * stake — so the fail directions are asserted individually rather than assumed uniform:
 *
 *  - `llmText` → `''` (no verdict, not a wrong one)
 *  - `detectChannelPreferences` → safe defaults, every flag `false`
 *  - `classifyCallOutcome` → `no_commitment`, so a bad read NEVER auto-books
 *  - `emailOptOutDetected` → TRUE on a missing verdict (honour a possible opt-out; compliance-safe)
 *  - the callback-number check → FALSE (TCPA: never open the phone channel on a guess)
 *
 * The last two point in OPPOSITE directions on purpose, which is the thing most likely to be
 * "normalized" by mistake.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../llm/ask', () => {
  const actual = jest.requireActual('../../llm/ask');
  return { ...actual, generateText: jest.fn() };
});

import { store } from '../../testSupport/mockFirestore';
import { generateText } from '../../llm/ask';
import {
  CALL_OUTCOME_VALUES,
  channelPrefSafeDefaults,
  classifyCallOutcome,
  detectChannelPreferences,
  extractFromTranscriptWithSchema,
  llmText,
  parseJsonResponse,
  resolveStageAndSkills,
  __testing as rh,
} from '../../tools/reviewHelpers';
import {
  capturePhoneConsentFromReply,
  emailOptOutDetected,
} from '../../services/emailReview';
import { PEWC_DISCLOSURE_TEXT } from '../../services/emailText';

const gen = generateText as jest.Mock;
const CHAT = 'outbound__agentA__15551230000';

/** Make `generateText` return the given text as a Bedrock-shaped assistant turn. */
function replyWith(text: string) {
  gen.mockResolvedValue({
    stopReason: 'end_turn',
    toolsRequested: [],
    payload: { role: 'assistant', content: [{ text }] },
    tokenUsage: {},
  });
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  replyWith('{}');
  store.set('agents/agentA', { sales_agent_name: 'Nova' });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('llmText', () => {
  it('returns the assistant text', async () => {
    replyWith('  hello  ');
    await expect(llmText('sys', 'user')).resolves.toBe('hello');
  });

  it('returns "" on any error — no verdict beats a wrong one', async () => {
    gen.mockRejectedValue(new Error('model down'));
    await expect(llmText('sys', 'user')).resolves.toBe('');
  });
});

describe('parseJsonResponse — models emit three shapes', () => {
  it('parses bare JSON', () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block, with or without a language tag', () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonResponse('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON embedded in prose', () => {
    expect(
      parseJsonResponse('Sure! Here you go: {"a":1} — hope that helps.')
    ).toEqual({ a: 1 });
  });

  it('takes the WIDEST brace span, so nested objects survive', () => {
    expect(parseJsonResponse('x {"a":{"b":2}} y')).toEqual({ a: { b: 2 } });
  });

  it('is {} for unparseable, empty, or non-object output', () => {
    expect(parseJsonResponse('not json at all')).toEqual({});
    expect(parseJsonResponse('')).toEqual({});
    expect(parseJsonResponse(null)).toEqual({});
    expect(parseJsonResponse('[1,2]')).toEqual([1, 2] as never); // an array IS an object
    expect(parseJsonResponse('42')).toEqual({});
  });
});

describe('resolveStageAndSkills', () => {
  it('reads the stage and labels off the chat document', async () => {
    store.set(`chats/${CHAT}`, { stage: 'Engaged', labels: ['hot'] });
    const [stage] = await resolveStageAndSkills(CHAT, 'agentA');
    expect(stage).toBe('Engaged');
  });

  it('defaults to New for a missing chat or a falsy id', async () => {
    expect((await resolveStageAndSkills('nope', 'agentA'))[0]).toBe('New');
    expect((await resolveStageAndSkills('', 'agentA'))[0]).toBe('New');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('schema extraction', () => {
  const schema = {
    budget: { type: 'number', description: 'stated budget' },
    ready: { type: 'boolean', description: 'ready to buy' },
    tier: { type: 'string', description: 'plan', enum: ['basic', 'pro'] },
  };

  it('coerces types the model returned as strings', async () => {
    replyWith('{"budget":"1500","ready":"yes"}');
    const out = await extractFromTranscriptWithSchema('AGENT: hi', schema);
    expect(out.budget).toBe(1500);
    expect(out.ready).toBe(true);
  });

  it('DROPS keys not in the schema — the model must not write arbitrary memory', async () => {
    replyWith('{"budget":100,"sneaky_field":"x"}');
    const out = await extractFromTranscriptWithSchema('AGENT: hi', schema);
    expect(out).toEqual({ budget: 100 });
  });

  it('retries with a stricter prompt when NOTHING parsed', async () => {
    gen
      .mockResolvedValueOnce({
        payload: { role: 'assistant', content: [{ text: 'I cannot help' }] },
      })
      .mockResolvedValueOnce({
        payload: { role: 'assistant', content: [{ text: '{"budget":50}' }] },
      });
    const out = await extractFromTranscriptWithSchema('AGENT: hi', schema);
    expect(out).toEqual({ budget: 50 });
    expect(gen).toHaveBeenCalledTimes(2);
    // The retry names the failure it is addressing.
    expect(String(gen.mock.calls[1][1][0].content[0].text)).toContain(
      'Output ONLY a JSON object'
    );
  });

  it('retries an ENUM mismatch by naming each bad value and its allowed list', async () => {
    gen
      .mockResolvedValueOnce({
        payload: {
          role: 'assistant',
          content: [{ text: '{"tier":"enterprise","budget":10}' }],
        },
      })
      .mockResolvedValueOnce({
        payload: { role: 'assistant', content: [{ text: '{"tier":"pro"}' }] },
      });
    const out = await extractFromTranscriptWithSchema('AGENT: hi', schema);
    // The valid field survived the first pass; the corrected one was merged in.
    expect(out).toEqual({ budget: 10, tier: 'pro' });
    expect(String(gen.mock.calls[1][1][0].content[0].text)).toContain(
      'enterprise'
    );
  });

  it('gives up after two parse failures', async () => {
    replyWith('still not json');
    await expect(
      extractFromTranscriptWithSchema('AGENT: hi', schema)
    ).resolves.toEqual({});
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it('short-circuits with no transcript or no schema — no model call', async () => {
    expect(await extractFromTranscriptWithSchema('', schema)).toEqual({});
    expect(await extractFromTranscriptWithSchema('AGENT: hi', {})).toEqual({});
    expect(gen).not.toHaveBeenCalled();
  });

  it('truncates a long transcript from the FRONT, keeping the recent end', async () => {
    replyWith('{"budget":1}');
    const long = 'x'.repeat(20_000) + 'THE-COMMITMENT-IS-HERE';
    await extractFromTranscriptWithSchema(long, schema);
    const sent = String(gen.mock.calls[0][1][0].content[0].text);
    expect(sent).toContain('THE-COMMITMENT-IS-HERE');
    expect(sent).toContain('earlier messages truncated');
  });

  it('renders enum values into the schema text so the model sees the constraint', () => {
    expect(rh.buildSchemaText(schema)).toContain(
      '[allowed values: basic, pro]'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('detectChannelPreferences', () => {
  it('merges a partial verdict onto safe defaults', async () => {
    replyWith('{"phone_opt_out":true}');
    const p = await detectChannelPreferences('AGENT: hi', 'phone_call', 'now');
    expect(p.phone_opt_out).toBe(true);
    expect(p.sms_opt_out).toBe(false); // defaulted, not undefined
    expect(p.referral.is_referral).toBe(false);
  });

  it('returns safe defaults when nothing parsed — every flag false', async () => {
    replyWith('garbage');
    const p = await detectChannelPreferences('AGENT: hi', 'phone_call', 'now');
    expect(p).toEqual(channelPrefSafeDefaults());
    expect(p.phone_opt_out).toBe(false);
    expect(p.sms_opt_out).toBe(false);
  });

  it('instructs the model that declining is NOT an opt-out', async () => {
    // The rule is in the prompt, and conflating the two is unrecoverable, so assert it is present.
    replyWith('{}');
    await detectChannelPreferences('AGENT: hi', 'phone_call', 'now');
    const sys = String(gen.mock.calls[0][0]);
    expect(sys).toContain('DECLINING THE OFFER IS NOT AN OPT-OUT');
    expect(sys).toContain('keep sms_opt_out=false');
  });

  it('instructs the model that a referral OUTRANKS followup_email', async () => {
    replyWith('{}');
    await detectChannelPreferences('AGENT: hi', 'email', 'now');
    const sys = String(gen.mock.calls[0][0]);
    expect(sys).toContain('takes PRECEDENCE over followup_email');
    expect(sys).toContain(
      "Never put a different person's contact detail in followup_email"
    );
  });
});

describe('classifyCallOutcome — the single demo-vs-callback authority', () => {
  it('returns a recognised outcome with its agreed time', async () => {
    replyWith(
      '{"outcome":"demo","agreed_time":"2026-08-12T14:00:00Z","quote":"yes"}'
    );
    const r = await classifyCallOutcome('AGENT: hi', 'now');
    expect(r.outcome).toBe('demo');
    expect(r.agreed_time).toBe('2026-08-12T14:00:00Z');
  });

  it('coerces an UNRECOGNISED outcome to no_commitment — never auto-books on junk', async () => {
    replyWith('{"outcome":"definitely_a_sale"}');
    expect((await classifyCallOutcome('AGENT: hi', 'now')).outcome).toBe(
      'no_commitment'
    );
  });

  it('falls back to no_commitment on an unparseable or failed call', async () => {
    replyWith('not json');
    expect((await classifyCallOutcome('AGENT: hi', 'now')).outcome).toBe(
      'no_commitment'
    );
    gen.mockRejectedValue(new Error('model down'));
    expect((await classifyCallOutcome('AGENT: hi', 'now')).outcome).toBe(
      'no_commitment'
    );
  });

  it('tells the model to prefer callback when genuinely unsure', async () => {
    // The tie-break is the safety property: never assume a booked demo on doubt.
    replyWith('{}');
    await classifyCallOutcome('AGENT: hi', 'now');
    const sys = String(gen.mock.calls[0][0]);
    expect(sys).toContain('TIE-BREAK');
    expect(sys).toContain('never assume a booked demo on doubt');
  });

  it('accepts exactly the five documented outcomes', () => {
    expect(CALL_OUTCOME_VALUES).toEqual([
      'demo',
      'callback',
      'referral',
      'not_interested',
      'no_commitment',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('emailOptOutDetected — regex pre-filter, LLM verdict', () => {
  it('is FALSE on a regex miss, with NO model call', async () => {
    expect(
      await emailOptOutDetected('Re: demo', 'Sounds great, Tuesday works')
    ).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });

  it('confirms a genuine opt-out', async () => {
    replyWith('{"opt_out":true}');
    expect(await emailOptOutDetected('', 'please unsubscribe me')).toBe(true);
  });

  it('REJECTS a question or a negation that tripped the regex', async () => {
    replyWith('{"opt_out":false}');
    expect(
      await emailOptOutDetected('', 'is there an unsubscribe option later?')
    ).toBe(false);
    expect(await emailOptOutDetected('', "please don't remove me")).toBe(false);
  });

  it('falls back to TRUE on a missing verdict — compliance-safe', async () => {
    // The regex already matched; failing toward honouring the opt-out is never weaker.
    replyWith('{"something_else":1}');
    expect(await emailOptOutDetected('', 'unsubscribe')).toBe(true);
  });

  it('strips quoted history first, so our own footer cannot trip it', async () => {
    const reply = 'Sounds good!\n\n--\nNova | Acme\nopt out: https://x';
    expect(await emailOptOutDetected('', reply)).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });
});

describe('capturePhoneConsentFromReply — the PEWC distinction', () => {
  function seedClosedPhoneChat(outboundBody: string) {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      phone_opt_out: true,
      memory: {
        agent_id: 'agentA',
        customer_email: 'a@b.com',
        timezone: 'UTC',
      },
    });
    store.set(`chats/${CHAT}/messages_v3/out1`, {
      timestamp: new Date('2026-08-01T10:00:00Z'),
      source: 'email',
      direction: 'outbound',
      content: { body: outboundBody },
    });
    store.set(`chats/${CHAT}/messages_v3/in1`, {
      timestamp: new Date('2026-08-02T10:00:00Z'),
      source: 'email',
      direction: 'inbound',
      content: { body: 'Sure, call me at 908-386-4637' },
    });
  }

  it('with the disclosure on record: captures, reopens, and SCHEDULES a call', async () => {
    seedClosedPhoneChat(`Best number? ${PEWC_DISCLOSURE_TEXT}`);
    replyWith('{"is_callback":true,"number":"9083864637"}');

    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(true);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d.phone_opt_out).toBe(false); // channel reopened
    const consent = (d.memory as Record<string, never>)
      ._phone_consent as Record<string, unknown>;
    expect(consent.pewc).toBe(true);
    // Written consent → an automated call is queued.
    const tasks = store.collection(`chats/${CHAT}/tasks`);
    expect(tasks).toHaveLength(1);
    expect((tasks[0][1].data as Record<string, unknown>).task_source).toBe(
      'email_consent_call'
    );
  });

  it('WITHOUT the disclosure: reopens for MANUAL follow-up and schedules NO call', async () => {
    // This is the whole reason the marker must stay byte-stable — getting it backwards would place an
    // automated voice call without written consent.
    seedClosedPhoneChat('What is the best number to reach you?');
    replyWith('{"is_callback":true,"number":"9083864637"}');

    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(true);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d.phone_opt_out).toBe(false); // still reopened
    const consent = (d.memory as Record<string, never>)
      ._phone_consent as Record<string, unknown>;
    expect(consent.pewc).toBe(false);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0); // NO call
  });

  it('FAILS CLOSED when the model declines the number', async () => {
    seedClosedPhoneChat(PEWC_DISCLOSURE_TEXT);
    replyWith('{"is_callback":false}');
    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(false);
    expect(store.get(`chats/${CHAT}`)!.phone_opt_out).toBe(true); // still closed
  });

  it('FAILS CLOSED on an unparseable verdict', async () => {
    seedClosedPhoneChat(PEWC_DISCLOSURE_TEXT);
    replyWith('who knows');
    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(false);
  });

  it('does NOT act when the phone channel is already OPEN', async () => {
    // This is new consent, not a re-confirmation of a number we can already call.
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      phone_opt_out: false,
      memory: { agent_id: 'agentA', phone_number: '15551230000' },
    });
    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });

  it('does nothing with no phone number in the reply', async () => {
    seedClosedPhoneChat(PEWC_DISCLOSURE_TEXT);
    store.set(`chats/${CHAT}/messages_v3/in1`, {
      timestamp: new Date('2026-08-02T10:00:00Z'),
      source: 'email',
      direction: 'inbound',
      content: { body: 'no number here, just interest' },
    });
    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });

  it('rejects a number that does not normalize to 10 digits', async () => {
    seedClosedPhoneChat(PEWC_DISCLOSURE_TEXT);
    replyWith('{"is_callback":true,"number":"12345"}');
    expect(await capturePhoneConsentFromReply(CHAT, 'agentA')).toBe(false);
  });

  it('returns false for a falsy chat id', async () => {
    expect(await capturePhoneConsentFromReply('', 'agentA')).toBe(false);
  });
});
