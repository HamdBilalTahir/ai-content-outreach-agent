/**
 * @jest-environment node
 *
 * The campaign engine: the status machine, the two pacing bases, the cursor-driven sweeps, and the
 * enrollment batch.
 *
 * The properties worth pinning:
 *  - phone-lane contacts do NOT consume email `per_day` slots — that is what the separate
 *    `email_paced_count` base exists to prevent;
 *  - `enrolled_count` counts CHATS, not page rows, so skipped records cannot inflate it;
 *  - every sweep is cursor-driven and bounded, and the stalled sweep WRAPS while the others finish;
 *  - the resume cascade un-pauses only the chats THIS campaign paused.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/phoneScreening', () => ({
  screenPhoneAtEnroll: jest.fn().mockResolvedValue(false),
  FULL_SCRUB_FLAG: 'full_scrub_gate',
}));
// Verification reaches DNS; the batch's job is to react to a verdict, not to perform the lookup.
jest.mock('../../services/verification', () => ({
  verify: jest.fn().mockResolvedValue({ result: 'valid', detail: 'mx-pass' }),
}));

import { store } from '../../testSupport/mockFirestore';
import {
  DEFAULT_PER_DAY,
  addRecords,
  archiveCampaignBatch,
  createCampaign,
  dropExcludedMembers,
  enrollCampaignBatch,
  enrolledChannelKeys,
  enrolledContactIds,
  enrollingCampaignIds,
  getCampaign,
  isCampaignActive,
  pacingExecuteAt,
  pauseCampaign,
  pauseCampaignChatsBatch,
  pausedCampaignIds,
  pausingCampaignIds,
  resolveAudiencePage,
  resumeCampaign,
  resumeCampaignChatsBatch,
  runningCampaignIds,
  stopCampaign,
  stoppedUnarchivedCampaignIds,
} from '../../services/campaigns';
import { verify } from '../../services/verification';
import { COLLECTION as DNC_COLLECTION } from '../../services/dncAreaCodes';

const AGENT = 'agentA';

function csvContact(phone: string, email: string, id?: string) {
  return {
    contact_information: { phone_number: phone, email, first_name: 'X' },
    input_data: id ? { hubspot_contact_id: id } : {},
  };
}

async function newCampaign(
  over: Record<string, unknown> = {}
): Promise<string> {
  const id = await createCampaign({
    name: 'C',
    agentId: AGENT,
    perDay: 2,
    audience: { type: 'csv', contacts: [] },
    ...over,
  });
  return id;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (verify as jest.Mock).mockResolvedValue({
    result: 'valid',
    detail: 'mx-pass',
  });
  store.set(`agents/${AGENT}`, { sales_agent_name: 'Nova' });
  for (const ac of ['303', '212', '415']) {
    store.set(`${DNC_COLLECTION}/${ac}`, {
      area_code: ac,
      san_expiry_date: '2030-01-01',
    });
  }
});

describe('the status machine', () => {
  it('starts in enrolling with the pacing fields seeded', async () => {
    const id = await newCampaign();
    const c = (await getCampaign(id))!;
    expect(c.status).toBe('enrolling');
    expect(c.enrolled_count).toBe(0);
    expect(c.cursor).toBeNull();
    expect(c.pending_batches).toEqual([]);
    expect(c.exclude_contacted).toBe(true); // dedup on by default
  });

  it('defaults per_day when omitted', async () => {
    const id = await createCampaign({ agentId: AGENT });
    expect((await getCampaign(id))!.per_day).toBe(DEFAULT_PER_DAY);
  });

  it('stamps status_changed_at on every status write', async () => {
    const id = await newCampaign();
    await pauseCampaign(id);
    const c = (await getCampaign(id))!;
    expect(c.status).toBe('paused');
    expect(c.status_changed_at).toBeTruthy();
    expect(c.updatedAt).toBeTruthy();
  });

  it('isCampaignActive is true only for enrolling/running', async () => {
    const id = await newCampaign();
    expect(await isCampaignActive(id)).toBe(true);
    await pauseCampaign(id);
    expect(await isCampaignActive(id)).toBe(false);
    await resumeCampaign(id);
    expect(await isCampaignActive(id)).toBe(true);
    await stopCampaign(id);
    expect(await isCampaignActive(id)).toBe(false);
    expect(await isCampaignActive('missing')).toBe(false);
    expect(await isCampaignActive(null)).toBe(false);
  });

  it('resume returns to running when the source is drained, enrolling when not', async () => {
    const id = await newCampaign();
    await pauseCampaign(id);
    await resumeCampaign(id); // cursor null → drained
    expect((await getCampaign(id))!.status).toBe('running');

    store.set(`outbound_campaigns/${id}`, {
      ...store.get(`outbound_campaigns/${id}`)!,
      status: 'paused',
      cursor: '100',
    });
    await resumeCampaign(id);
    expect((await getCampaign(id))!.status).toBe('enrolling');
  });

  it('refuses to resume a STOPPED campaign — stopped is terminal', async () => {
    const id = await newCampaign();
    await stopCampaign(id);
    await resumeCampaign(id);
    expect((await getCampaign(id))!.status).toBe('stopped');
  });

  it('kicks off the right cascade flags for pause and stop', async () => {
    const id = await newCampaign();
    await pauseCampaign(id);
    let c = (await getCampaign(id))!;
    expect(c._pause_done).toBe(false);
    expect(c._pause_cursor).toBeNull();

    await stopCampaign(id);
    c = (await getCampaign(id))!;
    expect(c._archive_done).toBe(false);
    expect(c.stopped_at).toBeTruthy();
  });
});

describe('addRecords', () => {
  it('queues a batch while still enrolling', async () => {
    const id = await newCampaign();
    const r = await addRecords(id, { type: 'csv', contacts: [] });
    expect(r).toMatchObject({ ok: true, queued: 1, promoted: false });
    expect((await getCampaign(id))!.pending_batches).toHaveLength(1);
  });

  it('promotes immediately when the campaign is already running', async () => {
    const id = await newCampaign();
    store.set(`outbound_campaigns/${id}`, {
      ...store.get(`outbound_campaigns/${id}`)!,
      status: 'running',
    });
    const r = await addRecords(id, { type: 'csv', contacts: [] });
    expect(r).toMatchObject({ ok: true, promoted: true, status: 'enrolling' });
    expect((await getCampaign(id))!.cursor).toBeNull();
  });

  it('refuses on a paused or stopped campaign', async () => {
    const id = await newCampaign();
    await pauseCampaign(id);
    expect((await addRecords(id, {})).ok).toBe(false);
    await stopCampaign(id);
    expect((await addRecords(id, {})).ok).toBe(false);
  });

  it('excludes contacts already in THIS campaign', async () => {
    const id = await newCampaign();
    store.set('chats/c1', {
      campaign_id: id,
      memory: { hubspot_contact_id: 'h1' },
    });
    await addRecords(id, { type: 'csv', contacts: [] });
    const queued = (
      (await getCampaign(id))!.pending_batches as Array<Record<string, unknown>>
    )[0];
    expect(queued.exclude_contact_ids).toContain('h1');
  });

  it('reports missing', async () => {
    expect((await addRecords('nope', {})).ok).toBe(false);
  });
});

describe('enrolled contact / channel keys', () => {
  beforeEach(() => {
    store.set('chats/c1', {
      campaign_id: 'camp1',
      memory: {
        hubspot_contact_id: 'h1',
        phone_number: '13034430103',
        customer_email: 'A@B.com',
      },
    });
  });

  it('collects contact ids', async () => {
    await expect(enrolledContactIds('camp1')).resolves.toEqual(['h1']);
  });

  it('keys channels on the REAL collapse key, catching the shared-line case', async () => {
    // Contact-id dedup alone would miss a distinct contact sharing the dealership line.
    const keys = await enrolledChannelKeys('camp1');
    expect(keys.has('p:3034430103')).toBe(true); // last 10 digits
    expect(keys.has('e:a@b.com')).toBe(true); // lowercased
  });

  it('is empty for an unknown campaign', async () => {
    await expect(enrolledChannelKeys('nope')).resolves.toEqual(new Set());
  });
});

describe('pacing', () => {
  it('buckets by day and distributes within the window', () => {
    const a = pacingExecuteAt(0, 2, 'America/Denver', 'CO');
    const b = pacingExecuteAt(1, 2, 'America/Denver', 'CO');
    const c = pacingExecuteAt(2, 2, 'America/Denver', 'CO'); // next day
    expect(b.getTime()).toBeGreaterThan(a.getTime());
    expect(c.getTime()).toBeGreaterThan(b.getTime());
    // Slot 1 of 2 lands later in the same day than slot 0.
    expect(c.getTime() - b.getTime()).toBeGreaterThan(0);
  });

  it('is deterministic, which is what makes a paused campaign resumable to the same schedule', () => {
    expect(pacingExecuteAt(5, 10, 'UTC', null).getTime()).toBe(
      pacingExecuteAt(5, 10, 'UTC', null).getTime()
    );
  });

  it('sends Test records near-immediately with a small spread', () => {
    const t0 = pacingExecuteAt(0, 100, 'UTC', null, 'Test');
    const t1 = pacingExecuteAt(1, 100, 'UTC', null, 'Test');
    expect(t0.getTime()).toBeLessThan(Date.now() + 61_000);
    expect(t1.getTime()).not.toBe(t0.getTime());
  });
});

describe('resolveAudiencePage', () => {
  it('pages a csv audience by offset cursor', async () => {
    const contacts = [
      csvContact('+13034430101', 'a@b.com'),
      csvContact('+13034430102', 'b@b.com'),
      csvContact('+13034430103', 'c@b.com'),
    ];
    const camp = { audience: { type: 'csv', contacts } } as never;
    const p1 = await resolveAudiencePage(camp, null, 2);
    expect(p1.leads).toHaveLength(2);
    expect(p1.nextCursor).toBe('2');
    expect(p1.total).toBe(3);

    const p2 = await resolveAudiencePage(camp, '2', 2);
    expect(p2.leads).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });

  it('drops excluded contact ids', async () => {
    const camp = {
      audience: {
        type: 'csv',
        contacts: [
          csvContact('+13034430101', 'a@b.com', 'h1'),
          csvContact('+13034430102', 'b@b.com', 'h2'),
        ],
        exclude_contact_ids: ['h1'],
      },
    } as never;
    const p = await resolveAudiencePage(camp, null, 10);
    expect(p.leads).toHaveLength(1);
  });

  it('returns an empty page for a not-yet-ported HubSpot source rather than throwing', async () => {
    // An empty page lets the worker settle the campaign instead of spinning on it every tick.
    for (const type of ['hubspot_list', 'hubspot_search']) {
      const p = await resolveAudiencePage(
        { audience: { type } } as never,
        null,
        10
      );
      expect(p.leads).toEqual([]);
      expect(p.nextCursor).toBeNull();
    }
  });

  it('returns an empty page for an unknown type', async () => {
    const p = await resolveAudiencePage(
      { audience: { type: 'nonsense' } } as never,
      null,
      10
    );
    expect(p.leads).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('dropExcludedMembers is a no-op with no exclusions', () => {
    const members = [csvContact('+1303', 'a@b.com', 'h1')];
    expect(dropExcludedMembers(members, null)).toBe(members);
    expect(dropExcludedMembers(members, [])).toBe(members);
  });
});

describe('enrollCampaignBatch', () => {
  it('enrolls a page, advances the cursor, and settles to running when drained', async () => {
    const id = await newCampaign({
      audience: {
        type: 'csv',
        contacts: [
          csvContact('+13034430101', 'a@b.com'),
          csvContact('+12125550102', 'b@b.com'),
        ],
      },
    });
    const r = await enrollCampaignBatch(id, 10);
    expect(r.enrolled).toBe(2);
    expect(r.status).toBe('running'); // source exhausted, nothing queued

    const c = (await getCampaign(id))!;
    expect(c.enrolled_count).toBe(2);
    expect(c.total).toBe(2);
    expect(store.collection('chats')).toHaveLength(2);
  });

  it('does NOT let phone-lane contacts consume email per_day slots', async () => {
    // This is the whole reason `email_paced_count` is a separate base from `enrolled_count`.
    const id = await newCampaign({
      perDay: 2,
      audience: {
        type: 'csv',
        contacts: [
          csvContact('+13034430101', 'a@b.com'), // phone lane
          csvContact('+12125550102', 'b@b.com'), // phone lane
          csvContact('', 'c@b.com'), // email lane
        ],
      },
    });
    await enrollCampaignBatch(id, 10);
    const c = (await getCampaign(id))!;
    expect(c.enrolled_count).toBe(3);
    expect(c.email_paced_count).toBe(1); // only the email-lane contact advanced it
  });

  it('counts CHATS not rows, so a skipped record cannot inflate enrolled_count', async () => {
    (verify as jest.Mock).mockImplementation(async (e: string) =>
      e === 'bad@b.com'
        ? { result: 'invalid', detail: 'no-mx' }
        : { result: 'valid', detail: 'mx-pass' }
    );
    const id = await newCampaign({
      audience: {
        type: 'csv',
        contacts: [
          csvContact('+13034430101', 'a@b.com'), // enrolls
          csvContact('', 'bad@b.com'), // invalid + no phone → dropped
          csvContact('+19995550103', 'c@b.com'), // area code filtered by the registry
        ],
      },
    });
    const r = await enrollCampaignBatch(id, 10);
    expect(r.enrolled).toBe(2); // the unscrubbable one still enrolls, on the email lane
    expect(r.skipped_invalid).toBe(1);
    const c = (await getCampaign(id))!;
    expect(c.enrolled_count).toBe(2);
    expect((c.last_enroll_stats as Record<string, number>).page).toBe(3);
  });

  it('enrolls an invalid-email contact on the PHONE lane rather than dropping it', async () => {
    (verify as jest.Mock).mockResolvedValue({
      result: 'invalid',
      detail: 'no-mx',
    });
    const id = await newCampaign({
      audience: {
        type: 'csv',
        contacts: [csvContact('+13034430101', 'bad@b.com')],
      },
    });
    const r = await enrollCampaignBatch(id, 10);
    expect(r.enrolled).toBe(1);
    expect(r.enrolled_bad_email).toBe(1);
    const chat = store.collection('chats')[0][1];
    expect(chat.email_invalid).toBe(true);
    expect(chat.outreach_lane).toBe('phone');
  });

  it('drops records outside the campaign area-code selection', async () => {
    const id = await newCampaign({
      audience: {
        type: 'csv',
        area_codes: ['303'],
        contacts: [
          csvContact('+13034430101', 'a@b.com'),
          csvContact('+12125550102', 'b@b.com'), // 212 not in the selection
        ],
      },
    });
    const r = await enrollCampaignBatch(id, 10);
    expect(r.enrolled).toBe(1);
    expect(r.skipped_area_code).toBe(1);
  });

  it('accumulates enroll_stats across batches', async () => {
    const id = await newCampaign({
      audience: {
        type: 'csv',
        contacts: [
          csvContact('+13034430101', 'a@b.com'),
          csvContact('+13034430102', 'b@b.com'),
        ],
      },
    });
    await enrollCampaignBatch(id, 1);
    await enrollCampaignBatch(id, 1);
    const stats = (await getCampaign(id))!.enroll_stats as Record<
      string,
      number
    >;
    expect(stats.enrolled).toBe(2);
  });

  it('promotes a queued batch instead of finishing', async () => {
    const id = await newCampaign({
      audience: {
        type: 'csv',
        contacts: [csvContact('+13034430101', 'a@b.com')],
      },
    });
    await addRecords(id, {
      type: 'csv',
      contacts: [csvContact('+13034430102', 'b@b.com')],
    });
    const r = await enrollCampaignBatch(id, 10);
    expect(r.status).toBe('enrolling'); // promoted, not finished
    const c = (await getCampaign(id))!;
    expect(c.pending_batches).toHaveLength(0);
    expect(c.cursor).toBeNull();
  });

  it('is a no-op unless the campaign is enrolling', async () => {
    const id = await newCampaign();
    await pauseCampaign(id);
    expect(await enrollCampaignBatch(id)).toMatchObject({
      status: 'paused',
      enrolled: 0,
    });
    expect(await enrollCampaignBatch('missing')).toMatchObject({
      status: 'missing',
    });
  });
});

describe('the chat cascades', () => {
  const CAMP = 'camp1';

  function seedChats(n: number, over: Record<string, unknown> = {}) {
    for (let i = 0; i < n; i += 1) {
      store.set(`chats/chat${String(i).padStart(3, '0')}`, {
        campaign_id: CAMP,
        type: 'outbound',
        status: 'active',
        memory: { timezone: 'UTC' },
        ...over,
      });
    }
  }

  it('pause cascade marks active chats and finishes on a short page', async () => {
    store.set(`outbound_campaigns/${CAMP}`, {
      status: 'paused',
      _pause_done: false,
      agent_id: AGENT,
    });
    seedChats(3);
    const r = await pauseCampaignChatsBatch(CAMP);
    expect(r.paused).toBe(3);
    expect(r.done).toBe(true);
    expect(store.get('chats/chat000')!.status).toBe('paused');
    expect(store.get('chats/chat000')!.paused_by).toBe(`campaign:${CAMP}`);
  });

  it('pause cascade is a no-op once done', async () => {
    store.set(`outbound_campaigns/${CAMP}`, {
      status: 'paused',
      _pause_done: true,
    });
    seedChats(2);
    expect(await pauseCampaignChatsBatch(CAMP)).toMatchObject({
      paused: 0,
      done: true,
    });
  });

  it('resume cascade un-pauses ONLY the chats this campaign paused', async () => {
    store.set(`outbound_campaigns/${CAMP}`, {
      status: 'running',
      _resume_done: false,
    });
    store.set('chats/byCampaign', {
      campaign_id: CAMP,
      type: 'outbound',
      status: 'paused',
      paused_by: `campaign:${CAMP}`,
      memory: { timezone: 'UTC' },
    });
    store.set('chats/byHand', {
      campaign_id: CAMP,
      type: 'outbound',
      status: 'paused',
      paused_by: 'manual',
      memory: { timezone: 'UTC' },
    });
    const r = await resumeCampaignChatsBatch(CAMP);
    expect(r.resumed).toBe(1);
    expect(store.get('chats/byCampaign')!.status).toBe('active');
    expect(store.get('chats/byHand')!.status).toBe('paused'); // left alone
  });

  it('archive sweep parks non-engaged chats and SPARES engaged ones', async () => {
    store.set(`outbound_campaigns/${CAMP}`, {
      status: 'stopped',
      _archive_done: false,
      agent_id: AGENT,
    });
    store.set('chats/cold', { campaign_id: CAMP, stage: 'Contacted' });
    store.set('chats/hot', { campaign_id: CAMP, stage: 'Lead' });
    store.set('chats/warm', { campaign_id: CAMP, stage: 'Engaged' });

    const r = await archiveCampaignBatch(CAMP);
    expect(r.archived).toBe(1);
    expect(store.get('chats/cold')!.status).toBe('archived');
    expect(store.get('chats/cold')!.archive_reason).toBe('campaign_stopped');
    expect(store.get('chats/hot')!.status).toBeUndefined(); // spared
    expect(store.get('chats/warm')!.status).toBeUndefined();
  });

  it('archive sweep only runs for a stopped campaign', async () => {
    store.set(`outbound_campaigns/${CAMP}`, { status: 'running' });
    expect(await archiveCampaignBatch(CAMP)).toMatchObject({ archived: 0 });
  });
});

describe('the cron selectors', () => {
  it('selects each status the cron advances', async () => {
    store.set('outbound_campaigns/a', { status: 'enrolling' });
    store.set('outbound_campaigns/b', { status: 'paused', _pause_done: false });
    store.set('outbound_campaigns/c', { status: 'paused', _pause_done: true });
    store.set('outbound_campaigns/d', { status: 'running' });
    store.set('outbound_campaigns/e', {
      status: 'stopped',
      _archive_done: false,
    });
    store.set('outbound_campaigns/f', {
      status: 'stopped',
      _archive_done: true,
    });

    expect(await enrollingCampaignIds()).toEqual(['a']);
    expect(await pausingCampaignIds()).toEqual(['b']); // c is done
    expect(await stoppedUnarchivedCampaignIds()).toEqual(['e']); // f is done
    expect([...(await pausedCampaignIds())].sort()).toEqual(['b', 'c']);
    expect((await runningCampaignIds()).sort()).toEqual(['a', 'd']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 10; i += 1) {
      store.set(`outbound_campaigns/e${i}`, { status: 'enrolling' });
    }
    expect(await enrollingCampaignIds(3)).toHaveLength(3);
  });
});
