/**
 * @jest-environment node
 *
 * The campaign and chat pause/resume views.
 *
 * `validateAudience` gets the bulk of the attention because it is the only gate between an FE payload
 * and a campaign that will enroll thousands of contacts. Everything else here is a status projection or
 * a lifecycle flip, and what those tests protect is the *status codes* — a 201 that becomes a 200, or a
 * 404 that becomes a 500, is a change the FE sees and the service layer's own suites cannot catch.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../services/campaigns', () => ({
  createCampaign: jest.fn(),
  getCampaign: jest.fn(),
  listCampaigns: jest.fn(),
  addRecords: jest.fn(),
  pauseCampaign: jest.fn(),
  resumeCampaign: jest.fn(),
  stopCampaign: jest.fn(),
}));
jest.mock('../../services/chatPause', () => ({
  pauseChat: jest.fn(),
  resumeChat: jest.fn(),
  pauseChats: jest.fn(),
  resumeChats: jest.fn(),
}));

import {
  campaignActionView,
  campaignAddRecordsView,
  campaignDetailView,
  campaignPauseView,
  campaignResumeView,
  campaignStopView,
  chatPauseView,
  chatResumeView,
  chatsPauseView,
  chatsResumeView,
  createCampaignView,
  listCampaignsView,
  validateAudience,
} from '../../http/campaignViews';
import {
  addRecords,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  stopCampaign,
} from '../../services/campaigns';
import {
  pauseChat,
  pauseChats,
  resumeChat,
  resumeChats,
} from '../../services/chatPause';
import type { OutboundRequest } from '../../http/types';

function req(over: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query: {},
    headers: {},
    body: {},
    bodyArray: null,
    rawBody: '',
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// validateAudience
// ─────────────────────────────────────────────────────────────────────────────

describe('validateAudience', () => {
  it('rejects a non-object', () => {
    expect(validateAudience(null)[1]).toBe('audience object is required');
    expect(validateAudience('csv')[1]).toBe('audience object is required');
    // An array is an object in JS but not a descriptor. Python's `isinstance(x, dict)` excludes lists.
    expect(validateAudience([])[1]).toBe('audience object is required');
  });

  it('rejects an unknown or absent type', () => {
    expect(validateAudience({})[1]).toMatch(/audience.type must be one of/);
    expect(validateAudience({ type: 'salesforce' })[1]).toMatch(
      /audience.type must be one of/
    );
  });

  it('requires the picker each type needs', () => {
    expect(validateAudience({ type: 'csv' })[1]).toBe(
      'audience.contacts is required for a csv campaign'
    );
    expect(validateAudience({ type: 'hubspot_list' })[1]).toBe(
      'audience.list_id is required for a hubspot_list campaign'
    );
    expect(validateAudience({ type: 'hubspot_search' })[1]).toBe(
      'audience.filterGroups (or filters) is required for a hubspot_search campaign'
    );
  });

  it('treats an EMPTY contacts array as no picker at all', () => {
    // `audience.get("contacts") or []` in the source — emptiness, not presence. A `contacts: []` csv
    // campaign has nobody to enroll, and accepting it would create a campaign that does nothing.
    expect(validateAudience({ type: 'csv', contacts: [] })[0]).toBe(false);
    expect(
      validateAudience({ type: 'csv', contacts: [{ phone: '1' }] })[0]
    ).toBe(true);
  });

  it('accepts either casing of the search filter key, and bare filters', () => {
    expect(
      validateAudience({ type: 'hubspot_search', filterGroups: [{}] })[0]
    ).toBe(true);
    expect(
      validateAudience({ type: 'hubspot_search', filter_groups: [{}] })[0]
    ).toBe(true);
    expect(validateAudience({ type: 'hubspot_search', filters: [{}] })[0]).toBe(
      true
    );
  });

  it.each(['csv', 'hubspot_list', 'hubspot_search'])(
    'lets include_contact_ids satisfy the picker requirement for %s',
    (type) => {
      // See the module note: an explicit id array is authoritative and self-sufficient, which is what
      // lets the FE preview a list, let the user deselect rows, and fire with the survivors.
      expect(
        validateAudience({ type, include_contact_ids: ['1', '2'] })[0]
      ).toBe(true);
    }
  );

  it('does NOT let an empty include_contact_ids satisfy the picker', () => {
    expect(
      validateAudience({ type: 'hubspot_list', include_contact_ids: [] })[0]
    ).toBe(false);
  });

  it('normalizes area_codes IN PLACE to the validated, deduped set', () => {
    const audience: Record<string, unknown> = {
      type: 'hubspot_list',
      list_id: '7',
      area_codes: ['303', '303', '770'],
    };
    expect(validateAudience(audience)[0]).toBe(true);
    expect(audience.area_codes).toEqual(['303', '770']);
  });

  it('rejects the whole request when ANY area code is invalid', () => {
    // Not "drop the bad ones": an area-code selection is a DNC-scrubbability claim, and enrolling only
    // the codes that happened to parse would dial the remainder unscrubbed.
    const [ok, err] = validateAudience({
      type: 'hubspot_list',
      list_id: '7',
      area_codes: ['303', '1', '999999'],
    });
    expect(ok).toBe(false);
    expect(err).toMatch(/invalid area_codes/);
  });

  it('accepts a single area code passed as a bare string', () => {
    const audience: Record<string, unknown> = {
      type: 'hubspot_list',
      list_id: '7',
      area_codes: '303',
    };
    expect(validateAudience(audience)[0]).toBe(true);
    expect(audience.area_codes).toEqual(['303']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create / list
// ─────────────────────────────────────────────────────────────────────────────

describe('createCampaignView', () => {
  const audience = { type: 'hubspot_list', list_id: '7' };

  it('creates the campaign and answers 201, not 200', async () => {
    (createCampaign as jest.Mock).mockResolvedValue('camp_1');
    const res = await createCampaignView(
      req({ body: { agent_id: 'a1', name: 'Q3 push', per_day: 50, audience } })
    );
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ campaign_id: 'camp_1', status: 'enrolling' });
    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a1',
        name: 'Q3 push',
        perDay: 50,
        excludeContacted: true,
        businessOnly: false,
      })
    );
  });

  it('400s without an agent_id, before touching the service', async () => {
    const res = await createCampaignView(req({ body: { audience } }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'agent_id is required' });
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('400s an invalid audience, before touching the service', async () => {
    const res = await createCampaignView(
      req({ body: { agent_id: 'a1', audience: { type: 'csv' } } })
    );
    expect(res.status).toBe(400);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('defaults exclude_contacted ON when the key is absent', async () => {
    (createCampaign as jest.Mock).mockResolvedValue('c');
    await createCampaignView(req({ body: { agent_id: 'a1', audience } }));
    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ excludeContacted: true })
    );
  });

  it.each([
    [false, false],
    [null, false],
    [0, false],
    [true, true],
  ])(
    'coerces exclude_contacted=%p to %p, as bool(data.get(k, True)) does',
    async (given, expected) => {
      // The DEFAULT fires only on an absent key; a present value is then coerced. `null` from the FE
      // therefore means OFF, not "unset" — which `??` would have got backwards.
      (createCampaign as jest.Mock).mockResolvedValue('c');
      await createCampaignView(
        req({ body: { agent_id: 'a1', audience, exclude_contacted: given } })
      );
      expect(createCampaign).toHaveBeenCalledWith(
        expect.objectContaining({ excludeContacted: expected })
      );
    }
  );

  it('folds top-level id selections into the audience', async () => {
    (createCampaign as jest.Mock).mockResolvedValue('c');
    await createCampaignView(
      req({
        body: {
          agent_id: 'a1',
          audience: { ...audience },
          exclude_contact_ids: ['9'],
          include_contact_ids: ['1', '2'],
        },
      })
    );
    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: expect.objectContaining({
          exclude_contact_ids: ['9'],
          include_contact_ids: ['1', '2'],
        }),
      })
    );
  });

  it('lets an audience that already carries the key win over the top-level shorthand', async () => {
    (createCampaign as jest.Mock).mockResolvedValue('c');
    await createCampaignView(
      req({
        body: {
          agent_id: 'a1',
          audience: { ...audience, exclude_contact_ids: ['inner'] },
          exclude_contact_ids: ['outer'],
        },
      })
    );
    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: expect.objectContaining({ exclude_contact_ids: ['inner'] }),
      })
    );
  });

  it('does not mutate the caller’s audience object', async () => {
    // `validateAudience` normalizes in place, so the view copies first. Without the copy an area-code
    // rewrite would reach back into the parsed request body.
    (createCampaign as jest.Mock).mockResolvedValue('c');
    const body = {
      agent_id: 'a1',
      audience: {
        type: 'hubspot_list',
        list_id: '7',
        area_codes: ['303', '303'],
      },
    };
    await createCampaignView(req({ body }));
    expect(body.audience.area_codes).toEqual(['303', '303']);
  });
});

describe('listCampaignsView', () => {
  it('passes the agent_id filter through', async () => {
    (listCampaigns as jest.Mock).mockResolvedValue([{ id: 'c1' }]);
    const res = await listCampaignsView(
      req({ method: 'GET', query: { agent_id: 'a1' } })
    );
    expect(listCampaigns).toHaveBeenCalledWith('a1');
    expect(res.json).toEqual({ campaigns: [{ id: 'c1' }] });
  });

  it('lists everything when no agent_id is given', async () => {
    (listCampaigns as jest.Mock).mockResolvedValue([]);
    await listCampaignsView(req({ method: 'GET' }));
    expect(listCampaigns).toHaveBeenCalledWith(undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detail
// ─────────────────────────────────────────────────────────────────────────────

describe('campaignDetailView', () => {
  it('projects the fields the FE progress bar reads', async () => {
    (getCampaign as jest.Mock).mockResolvedValue({
      id: 'c1',
      name: 'Q3',
      status: 'running',
      per_day: 100,
      record_type: 'Real',
      enrolled_count: 40,
      total: 250,
      business_only: true,
      created_at: '2026-07-01T00:00:00Z',
      // Not projected — the FE has no business reading the cursor or the queued batches.
      cursor: 'tok',
      pending_batches: [{}],
    });
    const res = await campaignDetailView(
      req({ params: { campaign_id: 'c1' } })
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      id: 'c1',
      name: 'Q3',
      status: 'running',
      per_day: 100,
      record_type: 'Real',
      enrolled_count: 40,
      total: 250,
      remaining: 210,
      business_only: true,
      created_at: '2026-07-01T00:00:00Z',
    });
  });

  it('reports remaining as NULL — not 0 — while total is uncounted', async () => {
    // The worker counts the audience asynchronously and leaves `total: null` until it has. Reporting
    // `0 remaining` would render a campaign that has barely started as finished.
    (getCampaign as jest.Mock).mockResolvedValue({
      id: 'c1',
      total: null,
      enrolled_count: 5,
    });
    expect(
      (await campaignDetailView(req({ params: { campaign_id: 'c1' } }))).json
    ).toMatchObject({ remaining: null });
  });

  it('floors remaining at 0 when enrollment overshot the count', async () => {
    (getCampaign as jest.Mock).mockResolvedValue({
      id: 'c1',
      total: 10,
      enrolled_count: 12,
    });
    expect(
      (await campaignDetailView(req({ params: { campaign_id: 'c1' } }))).json
    ).toMatchObject({ remaining: 0 });
  });

  it('404s a campaign that is not there', async () => {
    (getCampaign as jest.Mock).mockResolvedValue(null);
    const res = await campaignDetailView(
      req({ params: { campaign_id: 'nope' } })
    );
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'campaign not found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the lifecycle actions
// ─────────────────────────────────────────────────────────────────────────────

describe('the lifecycle actions', () => {
  it.each([
    ['pause', campaignPauseView, pauseCampaign],
    ['resume', campaignResumeView, resumeCampaign],
    ['stop', campaignStopView, stopCampaign],
  ])(
    '%s calls its service and returns the new status',
    async (name, view, fn) => {
      (fn as jest.Mock).mockResolvedValue({ id: 'c1', status: `${name}d` });
      const res = await view(req({ params: { campaign_id: 'c1' } }));
      expect(fn).toHaveBeenCalledWith('c1');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ id: 'c1', status: `${name}d` });
    }
  );

  it('routes the detail POST through the same handler by action name', async () => {
    (pauseCampaign as jest.Mock).mockResolvedValue({ status: 'paused' });
    const res = await campaignActionView(
      req({ params: { campaign_id: 'c1' }, body: { action: 'pause' } })
    );
    expect(pauseCampaign).toHaveBeenCalledWith('c1');
    expect(res.json).toEqual({ id: 'c1', status: 'paused' });
  });

  it.each([[undefined], [''], ['delete'], [null]])(
    '400s the action %p without calling anything',
    async (action) => {
      const res = await campaignActionView(
        req({ params: { campaign_id: 'c1' }, body: { action } })
      );
      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        error: "action must be 'pause', 'resume', or 'stop'",
      });
      expect(pauseCampaign).not.toHaveBeenCalled();
    }
  );

  it('404s when the service reports no such campaign', async () => {
    (stopCampaign as jest.Mock).mockResolvedValue(null);
    const res = await campaignStopView(
      req({ params: { campaign_id: 'gone' } })
    );
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'campaign not found' });
  });

  it('500s with a parseable error key when the service throws', async () => {
    // The source's docstring is explicit about this: never an unhandled HTML 500, because the FE
    // cannot show the user what it cannot parse.
    (pauseCampaign as jest.Mock).mockRejectedValue(new Error('firestore down'));
    const res = await campaignPauseView(req({ params: { campaign_id: 'c1' } }));
    expect(res.status).toBe(500);
    expect(res.json).toEqual({
      error: 'failed to pause campaign: Error: firestore down',
    });
  });

  it('400s a missing campaign_id', async () => {
    const res = await campaignPauseView(req({ params: {} }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'campaign_id is required' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// add-records
// ─────────────────────────────────────────────────────────────────────────────

describe('campaignAddRecordsView', () => {
  it('validates the audience and returns the service result verbatim', async () => {
    (addRecords as jest.Mock).mockResolvedValue({
      ok: true,
      status: 'enrolling',
      queued: 0,
      promoted: true,
    });
    const res = await campaignAddRecordsView(
      req({
        params: { campaign_id: 'c1' },
        body: { audience: { type: 'hubspot_list', list_id: '7' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      status: 'enrolling',
      queued: 0,
      promoted: true,
    });
  });

  it('400s — not 404 — for a campaign that is not there', async () => {
    // The source funnels every `add_records` refusal through one 400, including "not found" and
    // "campaign is paused". Reclassifying by message would be guesswork.
    (addRecords as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'campaign not found',
    });
    const res = await campaignAddRecordsView(
      req({
        params: { campaign_id: 'gone' },
        body: { audience: { type: 'hubspot_list', list_id: '7' } },
      })
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'campaign not found' });
  });

  it('400s an invalid audience without calling the service', async () => {
    const res = await campaignAddRecordsView(
      req({ params: { campaign_id: 'c1' }, body: { audience: {} } })
    );
    expect(res.status).toBe(400);
    expect(addRecords).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chat pause / resume
// ─────────────────────────────────────────────────────────────────────────────

describe('the single chat views', () => {
  it('pauses one chat, defaulting `by` to manual', async () => {
    (pauseChat as jest.Mock).mockResolvedValue(true);
    const res = await chatPauseView(req({ params: { chat_id: 'chat_1' } }));
    expect(pauseChat).toHaveBeenCalledWith('chat_1', 'manual');
    expect(res.json).toEqual({ chat_id: 'chat_1', paused: true });
  });

  it('honours an explicit `by`, which is what the audit trail reads', async () => {
    (pauseChat as jest.Mock).mockResolvedValue(true);
    await chatPauseView(
      req({ params: { chat_id: 'chat_1' }, body: { by: 'ops:jane' } })
    );
    expect(pauseChat).toHaveBeenCalledWith('chat_1', 'ops:jane');
  });

  it('reports paused:false as a normal 200', async () => {
    // The service refuses an already-paused or ARCHIVED chat, and archive is terminal — pausing it
    // would imply it could be resumed. That refusal is an answer, not an error.
    (pauseChat as jest.Mock).mockResolvedValue(false);
    const res = await chatPauseView(req({ params: { chat_id: 'archived_1' } }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ chat_id: 'archived_1', paused: false });
  });

  it('spreads the resume result alongside the chat id', async () => {
    (resumeChat as jest.Mock).mockResolvedValue({
      resumed: true,
      rescheduled: 3,
    });
    const res = await chatResumeView(req({ params: { chat_id: 'chat_1' } }));
    expect(res.json).toEqual({
      chat_id: 'chat_1',
      resumed: true,
      rescheduled: 3,
    });
  });
});

describe('the bulk chat views', () => {
  it('bulk-pauses, defaulting `by` to bulk rather than manual', async () => {
    (pauseChats as jest.Mock).mockResolvedValue({
      paused: 2,
      chat_ids: ['a', 'b'],
    });
    const res = await chatsPauseView(req({ body: { chat_ids: ['a', 'b'] } }));
    expect(pauseChats).toHaveBeenCalledWith(['a', 'b'], 'bulk');
    expect(res.json).toEqual({ paused: 2, chat_ids: ['a', 'b'] });
  });

  it('bulk-resumes, returning the summed reschedule count', async () => {
    (resumeChats as jest.Mock).mockResolvedValue({
      resumed: 2,
      rescheduled: 5,
      chat_ids: ['a', 'b'],
    });
    const res = await chatsResumeView(req({ body: { chat_ids: ['a', 'b'] } }));
    expect(resumeChats).toHaveBeenCalledWith(['a', 'b']);
    expect(res.json).toMatchObject({ resumed: 2, rescheduled: 5 });
  });

  it.each([[undefined], [[]], ['a,b'], [{}]])(
    '400s chat_ids=%p so an empty selection cannot read as a success',
    async (ids) => {
      const pauseRes = await chatsPauseView(req({ body: { chat_ids: ids } }));
      const resumeRes = await chatsResumeView(req({ body: { chat_ids: ids } }));
      expect(pauseRes.status).toBe(400);
      expect(resumeRes.status).toBe(400);
      expect(pauseChats).not.toHaveBeenCalled();
      expect(resumeChats).not.toHaveBeenCalled();
    }
  );

  it('stringifies the ids, so a numeric id from JSON still resolves a doc', async () => {
    (pauseChats as jest.Mock).mockResolvedValue({
      paused: 1,
      chat_ids: ['12'],
    });
    await chatsPauseView(req({ body: { chat_ids: [12] } }));
    expect(pauseChats).toHaveBeenCalledWith(['12'], 'bulk');
  });
});
