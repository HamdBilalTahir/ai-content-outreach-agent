/**
 * @jest-environment node
 *
 * Per-contact enrollment.
 *
 * The properties worth pinning:
 *  - opt-outs are **SET-ONLY** — re-enrolling never resets an existing opt-out to reachable;
 *  - the area-code gate SKIPS the DNC scrub, because scrubbing an un-subscribed area code buys
 *    nothing and costs money;
 *  - enrollment is NOT contact — the contacted marker is never stamped here, which is what keeps a
 *    never-outreached contact re-selectable by a later campaign;
 *  - no reachable channel → a chat but NO task;
 *  - a re-enroll reactivates from ARCHIVED but must leave a PAUSED chat paused.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
// The scrub reaches the network; enrollment's job is to react to its verdict, not to perform it.
jest.mock('../../services/phoneScreening', () => ({
  screenPhoneAtEnroll: jest.fn().mockResolvedValue(false),
  FULL_SCRUB_FLAG: 'full_scrub_gate',
}));

import { store } from '../../testSupport/mockFirestore';
import {
  enrollContact,
  markContacted,
  resolveLocation,
} from '../../services/enroll';
import { screenPhoneAtEnroll } from '../../services/phoneScreening';
import { COLLECTION as DNC_COLLECTION } from '../../services/dncAreaCodes';

const AGENT = 'agentA';
const PHONE = '+13034430103'; // area code 303
const EMAIL = 'a@b.com';

/** Register an area code so the compliance gate lets it through. */
function allowAreaCode(ac: string): void {
  store.set(`${DNC_COLLECTION}/${ac}`, {
    area_code: ac,
    san_id: 'SAN1',
    san_expiry_date: '2030-01-01',
  });
}

function lead(over: Record<string, unknown> = {}) {
  return {
    contact_information: {
      phone_number: PHONE,
      email: EMAIL,
      first_name: 'Ann',
      ...((over.contact_information as Record<string, unknown>) ?? {}),
    },
    input_data: {
      agent_id: AGENT,
      ...((over.input_data as Record<string, unknown>) ?? {}),
    },
  };
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (screenPhoneAtEnroll as jest.Mock).mockResolvedValue(false);
  allowAreaCode('303');
  store.set(`agents/${AGENT}`, { sales_agent_name: 'Nova', company_id: 'co1' });
});

describe('resolveLocation', () => {
  it('prefers explicit values over anything derived', () => {
    expect(
      resolveLocation(PHONE, { state: 'ny', timezone: 'America/New_York' })
    ).toEqual(['NY', 'America/New_York']);
  });

  it('derives from the ZIP before the phone', () => {
    const [state, tz] = resolveLocation(PHONE, { zip: '10001' });
    expect(state).toBe('NY'); // ZIP wins over the 303 area code
    expect(tz).toBe('America/New_York');
  });

  it('falls back to the phone area code', () => {
    expect(resolveLocation(PHONE, {})).toEqual(['CO', 'America/Denver']);
  });

  it('is [null, null] with nothing to go on', () => {
    expect(resolveLocation('', {})).toEqual([null, null]);
    expect(resolveLocation(null, null)).toEqual([null, null]);
  });
});

describe('enrollContact — the happy path', () => {
  it('creates the chat, seeds memory, sets the lane, and schedules ONE outreach task', async () => {
    const r = await enrollContact(lead());
    expect(r.success).toBe(true);
    expect(r.created).toBe(true);
    expect(r.task_id).toBeTruthy();

    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.type).toBe('outbound');
    expect(d.record_type).toBe('Real');
    expect(d.outreach_lane).toBe('phone'); // a reachable phone always calls first
    expect(d.status).toBe('active');

    const m = d.memory as Record<string, unknown>;
    expect(m.customer_email).toBe(EMAIL);
    expect(m.phone_number).toBe('13034430103'); // digits only
    expect(m.first_name).toBe('Ann');
    expect(m.sales_agent_name).toBe('Nova'); // resolved from the agent doc
    expect(m.state).toBe('CO');
    expect(m.timezone).toBe('America/Denver');
    expect(m._outreach_lane).toBe('phone');

    const tasks = store.collection(`chats/${r.chat_id}/tasks`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0][1].type).toBe('outbound_outreach');
    expect(tasks[0][1].executed).toBe(false);
  });

  it('picks the EMAIL lane when only an email is reachable', async () => {
    const r = await enrollContact(
      lead({ contact_information: { phone_number: '', email: EMAIL } })
    );
    expect(store.get(`chats/${r.chat_id}`)!.outreach_lane).toBe('email');
  });

  it('rejects a lead with no agent or no channel', async () => {
    await expect(
      enrollContact({ contact_information: { email: EMAIL }, input_data: {} })
    ).resolves.toMatchObject({ success: false });
    await expect(
      enrollContact(
        lead({ contact_information: { phone_number: '', email: '' } })
      )
    ).resolves.toMatchObject({ success: false });
  });

  it('copies through extra input fields but never a `_`-prefixed one', async () => {
    // `_`-prefixed keys are code-owned markers; a webhook payload must not be able to spoof one.
    const r = await enrollContact(
      lead({
        input_data: { company: 'Acme', _ob_state: 'spoofed', vertical: 'auto' },
      })
    );
    const m = store.get(`chats/${r.chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m.company).toBe('Acme');
    expect(m.vertical).toBe('auto');
    expect(m._ob_state).toBe('new'); // not 'spoofed'
  });
});

describe('enrollment is not contact', () => {
  it('never stamps the contacted marker', async () => {
    const r = await enrollContact(lead());
    const m = store.get(`chats/${r.chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m._nova_last_contacted).toBeUndefined();
    expect(m._ava_last_contacted).toBeUndefined();
  });

  it('markContacted stamps the NAME-DERIVED key and is idempotent', async () => {
    const r = await enrollContact(lead());
    await markContacted(r.chat_id!);
    const m1 = store.get(`chats/${r.chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    const first = m1._nova_last_contacted;
    expect(first).toBeTruthy();

    await markContacted(r.chat_id!);
    const m2 = store.get(`chats/${r.chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m2._nova_last_contacted).toBe(first); // unchanged
  });

  it('markContacted never throws on a missing chat', async () => {
    await expect(markContacted('nope')).resolves.toBeUndefined();
    await expect(markContacted('')).resolves.toBeUndefined();
  });
});

describe('the gate chain', () => {
  it('honours intake opt-out flags at ANY payload level', async () => {
    const r = await enrollContact(lead({ input_data: { phone_opt_out: 'Y' } }));
    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.phone_opt_out).toBe(true);
    expect(d.outreach_lane).toBe('email'); // phone closed → email lane
  });

  it('opts the phone out AND SKIPS the DNC scrub for an unregistered area code', async () => {
    // Scrubbing an un-subscribed area code would false-clean it and cost money for nothing.
    const r = await enrollContact(
      lead({
        contact_information: { phone_number: '+19995551234', email: EMAIL },
      })
    );
    expect(screenPhoneAtEnroll).not.toHaveBeenCalled();
    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.phone_opt_out).toBe(true);
    expect(d.labels).toContain('area_code_unscrubbable');
    expect((d.memory as Record<string, unknown>)._phone_optout_reason).toBe(
      'area_code_unscrubbable'
    );
  });

  it('runs the scrub when the area code IS registered, and honours a block verdict', async () => {
    (screenPhoneAtEnroll as jest.Mock).mockResolvedValue(true);
    const r = await enrollContact(lead());
    expect(screenPhoneAtEnroll).toHaveBeenCalled();
    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.phone_opt_out).toBe(true);
    expect(d.outreach_lane).toBe('email');
  });

  it('bypasses the area-code gate for a Test record', async () => {
    const r = await enrollContact(
      lead({
        contact_information: { phone_number: '+19995551234', email: EMAIL },
        input_data: { record_type: 'Test' },
      })
    );
    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.labels ?? []).not.toContain('area_code_unscrubbable');
    expect(d.phone_opt_out).toBe(false);
  });

  it('closes the email channel for a verified-invalid address but keeps the phone lane', async () => {
    const r = await enrollContact(lead(), { emailInvalid: true });
    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.email_invalid).toBe(true);
    expect(d.outreach_lane).toBe('phone'); // still dialable
    expect(r.task_id).toBeTruthy();
  });

  it('creates the chat but NO task when nothing is reachable', async () => {
    const r = await enrollContact(
      lead({ input_data: { phone_opt_out: 'Y', email_opt_out: 'Y' } })
    );
    expect(r.success).toBe(true);
    expect(r.no_task).toBe(true);
    expect(r.reason).toBe('no_reachable_channel');
    expect(r.task_id).toBeNull();
    expect(store.collection(`chats/${r.chat_id}/tasks`)).toHaveLength(0);
    expect(
      (store.get(`chats/${r.chat_id}`)!.memory as Record<string, unknown>)
        ._no_reachable_channel
    ).toBe(true);
  });

  it('derives an email opt-out when an unscrubbable phone is the ONLY channel', async () => {
    const r = await enrollContact(
      lead({ contact_information: { phone_number: '+19995551234', email: '' } })
    );
    expect(r.no_task).toBe(true);
    expect(store.get(`chats/${r.chat_id}`)!.email_opt_out).toBe(true);
  });
});

describe('opt-outs are SET-ONLY across a re-enroll', () => {
  it('does NOT reset an existing opt-out to reachable', async () => {
    const first = await enrollContact(
      lead({ input_data: { email_opt_out: 'Y' } })
    );
    expect(store.get(`chats/${first.chat_id}`)!.email_opt_out).toBe(true);

    // Re-enroll the same contact with NO opt-out flags — the prior unsubscribe must survive.
    const second = await enrollContact(lead());
    expect(second.chat_id).toBe(first.chat_id);
    expect(second.created).toBe(false);
    expect(store.get(`chats/${first.chat_id}`)!.email_opt_out).toBe(true);
  });

  it('reactivates from ARCHIVED', async () => {
    const first = await enrollContact(lead());
    store.set(`chats/${first.chat_id}`, {
      ...store.get(`chats/${first.chat_id}`)!,
      status: 'archived',
      archived: true,
      archive_reason: 'campaign_stopped',
    });
    await enrollContact(lead());
    const d = store.get(`chats/${first.chat_id}`)!;
    expect(d.status).toBe('active');
    expect(d.archived).toBe(false);
    expect(d.archive_reason).toBeNull();
  });

  it('leaves a PAUSED chat paused — a pause must survive re-enrollment', async () => {
    const first = await enrollContact(lead());
    store.set(`chats/${first.chat_id}`, {
      ...store.get(`chats/${first.chat_id}`)!,
      status: 'paused',
    });
    await enrollContact(lead());
    expect(store.get(`chats/${first.chat_id}`)!.status).toBe('paused');
  });
});

describe('the campaign dedup guard', () => {
  it('skips a contact already contacted', async () => {
    const first = await enrollContact(lead());
    await markContacted(first.chat_id!);

    const r = await enrollContact(lead(), { skipIfContacted: true });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('already_contacted');
  });

  it('skips a contact still pending in another ACTIVE campaign', async () => {
    store.set('outbound_campaigns/other', { status: 'running' });
    const first = await enrollContact(lead(), { campaignId: 'other' });
    expect(first.success).toBe(true);

    const r = await enrollContact(lead(), {
      campaignId: 'mine',
      skipIfContacted: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('pending_in_active_campaign');
  });

  it('ALLOWS re-enroll when the other campaign is no longer active', async () => {
    store.set('outbound_campaigns/other', { status: 'stopped' });
    await enrollContact(lead(), { campaignId: 'other' });

    const r = await enrollContact(lead(), {
      campaignId: 'mine',
      skipIfContacted: true,
    });
    expect(r.skipped).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('does not skip on the same campaign', async () => {
    store.set('outbound_campaigns/mine', { status: 'running' });
    await enrollContact(lead(), { campaignId: 'mine' });
    const r = await enrollContact(lead(), {
      campaignId: 'mine',
      skipIfContacted: true,
    });
    expect(r.skipped).toBeUndefined();
  });

  it('uses a supplied allowed-area-code set instead of reading Firestore', async () => {
    // The campaign batch passes the registry once so enrollment does no per-record I/O.
    const r = await enrollContact(lead(), {
      allowedAreaCodes: new Set(['303']),
    });
    expect(store.get(`chats/${r.chat_id}`)!.phone_opt_out).toBe(false);

    const blocked = await enrollContact(
      lead({
        contact_information: { phone_number: '+12125551234', email: 'c@d.com' },
      }),
      { allowedAreaCodes: new Set(['303']) }
    );
    expect(store.get(`chats/${blocked.chat_id}`)!.phone_opt_out).toBe(true);
  });
});

describe('the test email-fallback reserve', () => {
  it('is set for a TEST record with BOTH channels reachable', async () => {
    const r = await enrollContact(
      lead({ input_data: { record_type: 'Test' } })
    );
    const d = store.get(`chats/${r.chat_id}`)!;
    expect(d.outreach_lane).toBe('phone');
    expect(d.email_fallback_available).toBe(true);
    expect(
      (d.memory as Record<string, unknown>)._email_fallback_available
    ).toBe(true);
  });

  it('is NOT set for a Real record, which keeps a fixed single lane', async () => {
    const r = await enrollContact(lead());
    expect(
      store.get(`chats/${r.chat_id}`)!.email_fallback_available
    ).toBeUndefined();
  });

  it('is NOT set for a test record with only one reachable channel', async () => {
    const r = await enrollContact(
      lead({
        contact_information: { phone_number: PHONE, email: '' },
        input_data: { record_type: 'Test' },
      })
    );
    expect(
      store.get(`chats/${r.chat_id}`)!.email_fallback_available
    ).toBeUndefined();
  });
});

describe('business_only', () => {
  it('marks memory so the PEWC consent-ask is suppressed', async () => {
    const r = await enrollContact(lead(), { businessOnly: true });
    expect(
      (store.get(`chats/${r.chat_id}`)!.memory as Record<string, unknown>)
        .business_only
    ).toBe(true);
  });
});
