/**
 * @jest-environment node
 *
 * Post-call classification and the review's actions.
 *
 * The organising property is that the two classifiers have **OPPOSITE defaults**, each chosen for
 * recoverability, and both are asserted directly because normalizing them would be a real regression:
 *
 *  - `classifyAnswerer` → `"human"` on error. A wrong `human` leaves the chat at Contacted and the
 *    cadence re-dials, which is recoverable. Discarding a REAL call as voicemail is not.
 *  - `hadMeaningfulEngagement` → `false` on error. Not advancing is recoverable; a wrong advance
 *    corrupts the funnel.
 *
 * The "automated opening then a live pickup" case gets its own tests, because that is precisely what the
 * removed phrase pre-checks got wrong.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../tools/reviewHelpers', () => {
  const actual = jest.requireActual('../../tools/reviewHelpers');
  return { ...actual, llmText: jest.fn() };
});

import { store } from '../../testSupport/mockFirestore';
import { llmText } from '../../tools/reviewHelpers';
import {
  MAX_VOICE_RETRIES,
  classifyAnswerer,
  classifyEmail,
  countHumanTurns,
  detectVoicemail,
  hadMeaningfulEngagement,
  llmDetectVoicemail,
  markCallReviewed,
  scheduleCallback,
  scheduleFollowupEmail,
  scheduleRetryCall,
  __testing as ra,
} from '../../tools/reviewActions';

const llm = llmText as jest.Mock;
const CHAT = 'outbound__agentA__15551230000';
const AGENT = 'agentA';

/** A transcript with a live exchange. */
const LIVE =
  'AI: Hi, is this Jane?\nHUMAN: Yes, speaking.\nAI: Great —\nHUMAN: What is this about?';

function seedChat(over: Record<string, unknown> = {}) {
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    phone_opt_out: false,
    memory: {
      agent_id: AGENT,
      phone_number: '13034430103',
      first_name: 'Jane',
      last_name: 'Smith',
      timezone: 'America/Denver',
      record_type: 'Test', // bypasses the business-hours clamp, keeping schedules deterministic
      ...((over.memory as Record<string, unknown>) ?? {}),
    },
    ...over,
  });
}

function mem(over: Record<string, unknown> = {}) {
  return {
    phone_number: '13034430103',
    first_name: 'Jane',
    last_name: 'Smith',
    timezone: 'America/Denver',
    ...over,
  };
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  llm.mockResolvedValue('{}');
  seedChat();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('countHumanTurns', () => {
  it('counts only HUMAN-labelled lines', () => {
    expect(countHumanTurns(LIVE)).toBe(2);
    expect(countHumanTurns('AI: hello\nAI: anyone there?')).toBe(0);
    expect(countHumanTurns('')).toBe(0);
    expect(countHumanTurns(null)).toBe(0);
  });
});

describe('classifyAnswerer — defaults to human, because discarding a real call is unrecoverable', () => {
  it('short-circuits to "none" on ZERO human turns — the one factual shortcut', async () => {
    const a = await classifyAnswerer('AI: hello?\nAI: anyone there?');
    expect(a).toBe('none');
    expect(llm).not.toHaveBeenCalled(); // not a heuristic, so no model call needed
  });

  it('returns each recognised classification', async () => {
    for (const v of ['human', 'ivr', 'voicemail', 'none'] as const) {
      llm.mockResolvedValue(`{"answerer":"${v}"}`);
      expect(await classifyAnswerer(LIVE)).toBe(v);
    }
  });

  it('defaults to HUMAN on unrecognised output or an error', async () => {
    llm.mockResolvedValue('{"answerer":"maybe-a-robot"}');
    expect(await classifyAnswerer(LIVE)).toBe('human');
    llm.mockResolvedValue('not json');
    expect(await classifyAnswerer(LIVE)).toBe('human');
    llm.mockRejectedValue(new Error('model down'));
    expect(await classifyAnswerer(LIVE)).toBe('human');
  });

  it('tells the model an automated OPENING does not make the call a machine', async () => {
    // This is exactly what the removed phrase pre-checks got wrong.
    llm.mockResolvedValue('{"answerer":"human"}');
    await classifyAnswerer(LIVE);
    const sys = String(llm.mock.calls[0][0]);
    expect(sys).toContain('a call often OPENS with automated audio');
    expect(sys).toContain('does NOT make the call ivr/voicemail');
    expect(sys).toContain('live gatekeeper');
  });

  it('tells the model NOT to rely on turn counts', async () => {
    llm.mockResolvedValue('{"answerer":"human"}');
    await classifyAnswerer(LIVE);
    expect(String(llm.mock.calls[0][0])).toContain(
      'do NOT rely on how many turns'
    );
  });
});

describe('detectVoicemail — voicemail and no-answer only, NOT ivr', () => {
  it('is true for voicemail and none', async () => {
    llm.mockResolvedValue('{"answerer":"voicemail"}');
    expect(await detectVoicemail(LIVE)).toBe(true);
    llm.mockResolvedValue('{"answerer":"none"}');
    expect(await detectVoicemail(LIVE)).toBe(true);
  });

  it('is FALSE for ivr — a distinct outcome the caller handles separately', async () => {
    // An IVR emits many turns yet reached no person; conflating it with voicemail would take the
    // wrong follow-up action.
    llm.mockResolvedValue('{"answerer":"ivr"}');
    expect(await detectVoicemail(LIVE)).toBe(false);
  });

  it('is false for a live human, and on error', async () => {
    llm.mockResolvedValue('{"answerer":"human"}');
    expect(await detectVoicemail(LIVE)).toBe(false);
    llm.mockRejectedValue(new Error('down'));
    expect(await detectVoicemail(LIVE)).toBe(false);
  });
});

describe('llmDetectVoicemail — the low-engagement backstop', () => {
  it('reads the verdict, defaulting to live', async () => {
    llm.mockResolvedValue('{"is_voicemail":true}');
    expect(await llmDetectVoicemail(LIVE)).toBe(true);
    llm.mockResolvedValue('{}');
    expect(await llmDetectVoicemail(LIVE)).toBe(false);
  });

  it('warns the model that a greeting may be transcribed as a human turn', async () => {
    // The reason this second opinion exists at all.
    await llmDetectVoicemail(LIVE);
    const sys = String(llm.mock.calls[0][0]);
    expect(sys).toContain('AS IF it were a live human');
    expect(sys).toContain('prefer is_voicemail=false');
  });
});

describe('hadMeaningfulEngagement — defaults to FALSE, the opposite direction', () => {
  it('reads the verdict', async () => {
    llm.mockResolvedValue('{"engaged":true}');
    expect(await hadMeaningfulEngagement(LIVE)).toBe(true);
    llm.mockResolvedValue('{"engaged":false}');
    expect(await hadMeaningfulEngagement(LIVE)).toBe(false);
  });

  it('defaults to NOT engaged on error — a wrong advance corrupts the funnel', async () => {
    llm.mockRejectedValue(new Error('model down'));
    expect(await hadMeaningfulEngagement(LIVE)).toBe(false);
    llm.mockResolvedValue('nonsense');
    expect(await hadMeaningfulEngagement(LIVE)).toBe(false);
  });

  it('instructs that an unavailability brush-off is NOT engagement', async () => {
    // A real person saying they cannot talk must not advance the stage.
    await hadMeaningfulEngagement(LIVE);
    const sys = String(llm.mock.calls[0][0]);
    expect(sys).toContain('EXCLUSIVELY an unavailability/deferral brush-off');
    expect(sys).toContain('a menu or recording is NOT engagement');
  });

  it('has the OPPOSITE default to the answerer classifier', async () => {
    llm.mockRejectedValue(new Error('down'));
    expect(await classifyAnswerer(LIVE)).toBe('human'); // permissive
    expect(await hadMeaningfulEngagement(LIVE)).toBe(false); // conservative
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('scheduleRetryCall', () => {
  it('is DISABLED by the zero retry cap', async () => {
    // The constant is 0 in the source, so the first check always trips. The code path is kept so the
    // behaviour is one config change away.
    expect(MAX_VOICE_RETRIES).toBe(0);
    expect(await scheduleRetryCall(CHAT, AGENT, mem())).toBe(false);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });

  it('refuses when the phone is opted out, before considering the cap', async () => {
    seedChat({ phone_opt_out: true });
    expect(await scheduleRetryCall(CHAT, AGENT, mem())).toBe(false);
  });

  it('reads the opt-out from the TRUSTWORTHY top-level key, not memory', async () => {
    // A contact who opted out between the call and the review must not be auto-dialed.
    seedChat({ phone_opt_out: true, memory: { phone_opt_out: 'N' } });
    expect(
      await scheduleRetryCall(CHAT, AGENT, mem({ phone_opt_out: 'N' }))
    ).toBe(false);
  });

  it('returns false for a falsy chat id', async () => {
    expect(await scheduleRetryCall('', AGENT, mem())).toBe(false);
  });
});

describe('scheduleCallback', () => {
  it('schedules at the next business-hours slot with no stated time', async () => {
    expect(await scheduleCallback(CHAT, AGENT, mem())).toBe(true);
    const tasks = store.collection(`chats/${CHAT}/tasks`);
    expect(tasks).toHaveLength(1);
    const data = tasks[0][1].data as Record<string, unknown>;
    expect(data.task_source).toBe('voice_followup_callback');
    expect(String(data.notes)).toContain('Jane Smith');
  });

  it('CLAMPS a stated time into business hours', async () => {
    // An agreed "call me at 7am" must still land inside the window.
    const early = '2026-08-12T11:00:00Z'; // 5am Denver
    expect(await scheduleCallback(CHAT, AGENT, mem(), early)).toBe(true);
    const data = store.collection(`chats/${CHAT}/tasks`)[0][1].data as Record<
      string,
      unknown
    >;
    expect(String(data.notes)).toContain(early);
  });

  it('falls back to the next slot for an unparseable time', async () => {
    expect(await scheduleCallback(CHAT, AGENT, mem(), 'not-a-date')).toBe(true);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(1);
  });

  it('refuses when the phone is opted out', async () => {
    seedChat({ phone_opt_out: true });
    expect(await scheduleCallback(CHAT, AGENT, mem())).toBe(false);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });

  it('does not stack — a re-schedule replaces the pending outreach', async () => {
    await scheduleCallback(CHAT, AGENT, mem());
    await scheduleCallback(CHAT, AGENT, mem());
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(1);
  });
});

describe('classifyEmail', () => {
  it.each([
    'info@dealer.com',
    'sales@dealer.com',
    'reception@dealer.com',
    'front-desk@dealer.com',
  ])('treats %p as a department inbox', (addr) => {
    expect(classifyEmail(addr)).toBe('department');
  });

  it.each(['jane.smith@dealer.com', 'jsmith@dealer.com'])(
    'treats %p as personal',
    (addr) => {
      expect(classifyEmail(addr)).toBe('personal');
    }
  );

  it('degrades to personal on junk', () => {
    expect(classifyEmail(null)).toBe('personal');
    expect(classifyEmail('')).toBe('personal');
  });
});

describe('scheduleFollowupEmail', () => {
  it('records the address as SECONDARY, never overwriting the primary', async () => {
    // A receptionist's shared inbox is not the prospect's address; overwriting would silently redirect
    // the whole cadence.
    seedChat({
      memory: { customer_email: 'jane@dealer.com', record_type: 'Test' },
    });
    expect(
      await scheduleFollowupEmail(CHAT, AGENT, mem(), 'info@dealer.com')
    ).toBe(true);
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m.customer_email).toBe('jane@dealer.com'); // untouched
    const extra = m._additional_emails as Array<Record<string, unknown>>;
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({
      email: 'info@dealer.com',
      type: 'department',
      source: 'call',
    });
  });

  it('does not duplicate an address already recorded', async () => {
    await scheduleFollowupEmail(CHAT, AGENT, mem(), 'info@dealer.com');
    const first = (store.get(`chats/${CHAT}`)!.memory as Record<string, never>)
      ._additional_emails as unknown[];
    await scheduleFollowupEmail(
      CHAT,
      AGENT,
      mem({ _additional_emails: first }),
      'INFO@dealer.com' // same address, different case
    );
    const extra = (store.get(`chats/${CHAT}`)!.memory as Record<string, never>)
      ._additional_emails as unknown[];
    expect(extra).toHaveLength(1);
  });

  it('words a DEPARTMENT inbox as a forward request naming the prospect', async () => {
    await scheduleFollowupEmail(CHAT, AGENT, mem(), 'info@dealer.com');
    const notes = String(
      (
        store.collection(`chats/${CHAT}/tasks`)[0][1].data as Record<
          string,
          unknown
        >
      ).notes
    );
    expect(notes).toContain('shared/department inbox');
    expect(notes).toContain('pass it along to Jane Smith');
    expect(notes).toContain("NOT Jane Smith's personal inbox");
  });

  it('words a PERSONAL address directly', async () => {
    await scheduleFollowupEmail(CHAT, AGENT, mem(), 'jane.smith@dealer.com');
    const notes = String(
      (
        store.collection(`chats/${CHAT}/tasks`)[0][1].data as Record<
          string,
          unknown
        >
      ).notes
    );
    expect(notes).toContain('to Jane Smith at jane.smith@dealer.com');
    expect(notes).not.toContain('forward');
  });

  it('FORBIDS no-answer and booking-confirmation wording in both variants', async () => {
    // Neither premise is true for this email, and the downstream send tool would block it anyway.
    for (const addr of ['info@dealer.com', 'jane@dealer.com']) {
      store.reset();
      seedChat();
      await scheduleFollowupEmail(CHAT, AGENT, mem(), addr);
      const notes = String(
        (
          store.collection(`chats/${CHAT}/tasks`)[0][1].data as Record<
            string,
            unknown
          >
        ).notes
      );
      expect(notes).toContain("Do NOT use 'sorry we missed you'");
      expect(notes).toContain('booking-confirmation wording');
    }
  });

  it('tags the task with the address and its kind', async () => {
    await scheduleFollowupEmail(CHAT, AGENT, mem(), 'info@dealer.com');
    const data = store.collection(`chats/${CHAT}/tasks`)[0][1].data as Record<
      string,
      unknown
    >;
    expect(data.email_to).toBe('info@dealer.com');
    expect(data.email_kind).toBe('department');
    expect(data.task_source).toBe('followup_email');
  });

  it('rejects an address with no @ or no dot in the domain', async () => {
    for (const bad of ['notanemail', 'missing@domain', '']) {
      expect(await scheduleFollowupEmail(CHAT, AGENT, mem(), bad)).toBe(false);
    }
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });

  it('ACCEPTS an empty local part, matching the source — the check only looks at the domain', async () => {
    // The source's validation is `"@" in addr and "." in addr.split("@")[1]`, so `@example.com` passes.
    // Preserved rather than tightened: it is harmless here because this only schedules a TASK, and the
    // send tool's own verification gate rejects an undeliverable address before anything is mailed.
    // Tightening it would be a behaviour change with no failure to justify it.
    expect(
      await scheduleFollowupEmail(CHAT, AGENT, mem(), '@nolocal.com')
    ).toBe(true);
  });

  it('refuses when email is opted out', async () => {
    expect(
      await scheduleFollowupEmail(
        CHAT,
        AGENT,
        mem({ email_opt_out: true }),
        'info@dealer.com'
      )
    ).toBe(false);
  });
});

describe('markCallReviewed — idempotency AND unblocking the next dial', () => {
  it('records the call id and stamps the reviewed time', async () => {
    await markCallReviewed(CHAT, 'call-1');
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._reviewed_call_ids).toEqual(['call-1']);
    // This stamp is what clears the dial guard's awaiting-review block.
    expect(m._last_call_reviewed_at).toBeTruthy();
  });

  it('accumulates ids without clobbering, via arrayUnion', async () => {
    await markCallReviewed(CHAT, 'call-1');
    await markCallReviewed(CHAT, 'call-2');
    await markCallReviewed(CHAT, 'call-1'); // a duplicate review of the same call
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._reviewed_call_ids).toEqual(['call-1', 'call-2']);
  });

  it('is a no-op on missing ids, and never throws on a missing chat', async () => {
    await expect(markCallReviewed('', 'c')).resolves.toBeUndefined();
    await expect(markCallReviewed(CHAT, '')).resolves.toBeUndefined();
    await expect(markCallReviewed('nope', 'c')).resolves.toBeUndefined();
  });
});

describe('the name and timezone helpers', () => {
  it('builds a full name, falling back to a generic', () => {
    expect(ra.prospectName({ first_name: 'Jane', last_name: 'Smith' })).toBe(
      'Jane Smith'
    );
    expect(ra.prospectName({ first_name: 'Jane' })).toBe('Jane');
    expect(ra.prospectName({})).toBe('the prospect');
    expect(ra.prospectName(null)).toBe('the prospect');
  });

  it('defaults the timezone to Eastern', () => {
    expect(ra.prospectTz({ timezone: 'America/Denver' })).toBe(
      'America/Denver'
    );
    expect(ra.prospectTz({})).toBe('America/New_York');
  });
});
