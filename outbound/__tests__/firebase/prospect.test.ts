/**
 * @jest-environment node
 *
 * The prospect stage machine.
 *
 * These transition rules gate real outbound behaviour — cadence exhaustion only applies while a
 * prospect shows no engagement, the campaign archive sweep spares Engaged/Lead chats, and Lost stops
 * proactive outreach. A rule inverted here silently changes who gets called.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  BASELINE_SUB_STAGE,
  POST_LEAD_STAGES,
  STAGE_ORDER,
  VALID_STAGES,
  incrementContactAttempts,
  setProspectStage,
  setProspectSubStage,
  stageKey,
} from '../../firebase/prospect';

const CHAT = 'chat1';

function seed(data: Record<string, unknown> = {}): void {
  store.set(`chats/${CHAT}`, { type: 'outbound', memory: {}, ...data });
}

beforeEach(() => {
  store.reset();
});

describe('stageKey', () => {
  it('slugifies multi-word stages for use as a Firestore field key', () => {
    expect(stageKey('CRM Won')).toBe('crm_won');
    expect(stageKey('Pushed to CRM')).toBe('pushed_to_crm');
  });

  it('leaves single-word stages backward-compatible', () => {
    expect(stageKey('New')).toBe('new');
  });

  it('handles null/undefined', () => {
    expect(stageKey(null)).toBe('');
    expect(stageKey(undefined)).toBe('');
  });
});

describe('constants', () => {
  it('orders the canonical funnel', () => {
    expect(STAGE_ORDER).toEqual({
      New: 0,
      Contacted: 1,
      Engaged: 2,
      Lead: 3,
      'Pushed to CRM': 4,
      'CRM Won': 5,
    });
  });

  it('includes Lost as valid but outside the order', () => {
    expect(VALID_STAGES.has('Lost')).toBe(true);
    expect('Lost' in STAGE_ORDER).toBe(false);
  });

  it('treats inspection_completed as post-Lead but not part of the funnel order', () => {
    // Deliberate: keeping it out of STAGE_ORDER is what makes inspection_completed -> Lead legal.
    expect(POST_LEAD_STAGES).toContain('inspection_completed');
    expect('inspection_completed' in STAGE_ORDER).toBe(false);
  });
});

describe('setProspectStage — validation and no-ops', () => {
  it('rejects an empty stage', async () => {
    seed();
    expect(await setProspectStage(CHAT, '', 'test')).toBe(false);
    expect(await setProspectStage(CHAT, '   ', 'test')).toBe(false);
  });

  it('returns false for a missing chat', async () => {
    expect(await setProspectStage('nope', 'New', 'test')).toBe(false);
  });

  it('reports success for a same-stage no-op without writing history', async () => {
    seed({ stage: 'Contacted' });
    expect(await setProspectStage(CHAT, 'Contacted', 'test')).toBe(true);
    expect(store.get(`chats/${CHAT}`)!.stage_history).toBeUndefined();
  });
});

describe('setProspectStage — forward-only enforcement', () => {
  it('allows a forward transition and records it', async () => {
    seed({ stage: 'New' });
    expect(await setProspectStage(CHAT, 'Contacted', 'make_phone_call')).toBe(
      true
    );

    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Contacted');
    expect((doc.memory as Record<string, unknown>).current_stage).toBe(
      'Contacted'
    );
    expect(doc.stage_history).toHaveLength(1);
    expect(
      (doc.stage_history as Array<Record<string, unknown>>)[0]
    ).toMatchObject({
      from_stage: 'New',
      to_stage: 'Contacted',
      trigger: 'make_phone_call',
    });
  });

  it('allows any stage when there is no previous stage', async () => {
    seed();
    expect(await setProspectStage(CHAT, 'Engaged', 'first_touch')).toBe(true);
  });

  it('rejects a backward transition', async () => {
    seed({ stage: 'Engaged' });
    expect(await setProspectStage(CHAT, 'Contacted', 'test')).toBe(false);
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Engaged');
  });

  it('allows a backward transition when enforcement is off', async () => {
    seed({ stage: 'Engaged' });
    expect(
      await setProspectStage(
        CHAT,
        'Contacted',
        'test',
        null,
        null,
        undefined,
        false
      )
    ).toBe(true);
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Contacted');
  });

  it('allows Lost from any funnel stage and stamps a reason', async () => {
    seed({ stage: 'Contacted' });
    expect(
      await setProspectStage(
        CHAT,
        'Lost',
        'mark_prospect_lost',
        null,
        null,
        'no fit'
      )
    ).toBe(true);
    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lost');
    expect(doc.lost_reason).toBe('no fit');
  });

  it('defaults the lost reason to unknown', async () => {
    seed({ stage: 'New' });
    await setProspectStage(CHAT, 'Lost', 'test');
    expect(store.get(`chats/${CHAT}`)!.lost_reason).toBe('unknown');
  });

  it('treats Lost as terminal — nothing transitions out of it', async () => {
    seed({ stage: 'Lost' });
    expect(await setProspectStage(CHAT, 'Engaged', 'test')).toBe(false);
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Lost');
  });
});

describe('setProspectStage — the Lead lock', () => {
  it('records a post-Lead stage as a sub-stage, leaving stage at Lead', async () => {
    seed({ stage: 'Lead' });
    expect(await setProspectStage(CHAT, 'CRM Won', 'crm_sync')).toBe(true);

    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lead'); // never moves again
    expect(doc.sub_stage).toBe('crm_won');
    expect((doc.memory as Record<string, unknown>).sub_stage).toBe('crm_won');
  });

  it('records even a BACKWARD stage as a sub-stage once Lead is reached', async () => {
    // This is what keeps the Lead count monotonic: nothing can decrement it.
    seed({ stage: 'Lead' });
    expect(await setProspectStage(CHAT, 'Contacted', 'manual_api')).toBe(true);
    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lead');
    expect(doc.sub_stage).toBe('contacted');
  });

  it('records Lost as a sub-stage once Lead is reached', async () => {
    seed({ stage: 'Lead' });
    await setProspectStage(CHAT, 'Lost', 'test', null, null, 'went quiet');
    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lead');
    expect(doc.sub_stage).toBe('lost');
    expect(doc.lost_reason).toBe('went quiet');
  });

  it('stamps the baseline sub-stage when a chat first becomes a Lead', async () => {
    seed({ stage: 'Engaged' });
    await setProspectStage(CHAT, 'Lead', 'update_prospect');
    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lead');
    // Invariant: every Lead carries a sub-stage, so sub-stage occupancy sums to the Lead count.
    expect(doc.sub_stage).toBe(BASELINE_SUB_STAGE);
  });

  it('does not overwrite an existing sub-stage with the baseline', async () => {
    seed({ stage: 'Engaged', sub_stage: 'crm_won' });
    await setProspectStage(CHAT, 'Lead', 'test');
    expect(store.get(`chats/${CHAT}`)!.sub_stage).toBe('crm_won');
  });
});

describe('setProspectStage — promote-then-substage', () => {
  it('promotes a pre-Lead chat to Lead before recording a post-Lead value', async () => {
    // A CRM sync can deliver a record that is already won; the funnel must still show the Lead.
    seed({ stage: 'Contacted' });
    expect(await setProspectStage(CHAT, 'CRM Won', 'core_sync')).toBe(true);

    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lead');
    expect(doc.sub_stage).toBe('crm_won');
    // The promotion is visible in history, so the funnel transition is auditable.
    const history = doc.stage_history as Array<Record<string, unknown>>;
    expect(history.map((h) => h.to_stage)).toContain('Lead');
  });

  it('promotes from no stage at all', async () => {
    seed();
    expect(await setProspectStage(CHAT, 'Pushed to CRM', 'core_sync')).toBe(
      true
    );
    const doc = store.get(`chats/${CHAT}`)!;
    expect(doc.stage).toBe('Lead');
    expect(doc.sub_stage).toBe('pushed_to_crm');
  });
});

describe('setProspectStage — CRM Won bookkeeping', () => {
  it('stamps the entry time when entering CRM Won directly', async () => {
    seed({ stage: 'Pushed to CRM' });
    await setProspectStage(CHAT, 'CRM Won', 'test');
    // Reached via the Lead-lock path, so the stamp lands through the sub-stage writer.
    const memory = store.get(`chats/${CHAT}`)!.memory as Record<
      string,
      unknown
    >;
    expect(memory.crm_won_entered_at ?? memory.sub_stage).toBeDefined();
  });

  it('clears the entry stamp when leaving the crm_won sub-stage', async () => {
    seed({
      stage: 'Lead',
      sub_stage: 'crm_won',
      memory: { crm_won_entered_at: new Date() },
    });
    await setProspectSubStage(CHAT, 'Lost', 'test');
    const memory = store.get(`chats/${CHAT}`)!.memory as Record<
      string,
      unknown
    >;
    expect(memory.crm_won_entered_at).toBeUndefined();
  });
});

describe('setProspectSubStage', () => {
  it('rejects an empty sub-stage', async () => {
    seed({ stage: 'Lead' });
    expect(await setProspectSubStage(CHAT, '', 'test')).toBe(false);
  });

  it('canonicalizes the legacy "won" alias to crm_won at the write point', async () => {
    // Applied on WRITE so no caller can fragment the buckets.
    seed({ stage: 'Lead' });
    await setProspectSubStage(CHAT, 'won', 'old_client');
    expect(store.get(`chats/${CHAT}`)!.sub_stage).toBe('crm_won');
  });

  it('reports success for a same-value no-op without appending history', async () => {
    seed({ stage: 'Lead', sub_stage: 'crm_won' });
    expect(await setProspectSubStage(CHAT, 'CRM Won', 'test')).toBe(true);
    expect(store.get(`chats/${CHAT}`)!.sub_stage_history).toBeUndefined();
  });

  it('records the previous sub-stage in history', async () => {
    seed({ stage: 'Lead', sub_stage: 'new' });
    await setProspectSubStage(CHAT, 'Pushed to CRM', 'auto_push');
    const history = store.get(`chats/${CHAT}`)!.sub_stage_history as Array<
      Record<string, unknown>
    >;
    expect(history[0]).toMatchObject({
      from_sub_stage: 'new',
      to_sub_stage: 'pushed_to_crm',
      trigger: 'auto_push',
    });
  });

  it('returns false for a missing chat', async () => {
    expect(await setProspectSubStage('nope', 'crm_won', 'test')).toBe(false);
  });
});

describe('incrementContactAttempts', () => {
  it('increments atomically from absent', async () => {
    seed();
    await incrementContactAttempts(CHAT);
    await incrementContactAttempts(CHAT);
    expect(store.get(`chats/${CHAT}`)!.contact_attempts).toBe(2);
  });

  it('never throws for a missing chat', async () => {
    await expect(incrementContactAttempts('nope')).resolves.toBeUndefined();
  });
});
