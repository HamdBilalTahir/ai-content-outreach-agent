/**
 * @jest-environment node
 *
 * Skills inheritance and the agent/action resolvers.
 *
 * The merge is by NAME, not id, and an override with `status: 'inactive'` is how an operator
 * disables an inherited skill. If that inverted, a disabled skill would silently keep running.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  DEFAULT_STAGES,
  getAvailableStages,
  getSkillsForAgent,
  withCanonicalStages,
} from '../../firebase/skills';
import {
  getAgent,
  getAgentActions,
  getEnabledFunctionsForAgent,
} from '../../firebase/agent';

beforeEach(() => {
  store.reset();
});

describe('getSkillsForAgent — inheritance', () => {
  it('returns own skills when the agent has no parent', async () => {
    store.set('agents/a1', {});
    store.set('agents/a1/skills/s1', { name: 'outreach', status: 'active' });

    const skills = await getSkillsForAgent('a1');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('outreach');
  });

  it('inherits a parent skill the child does not define', async () => {
    store.set('agents/child', { parent_agent: 'master' });
    store.set('agents/master/skills/m1', {
      name: 'outreach',
      status: 'active',
    });

    const skills = await getSkillsForAgent('child');
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('inherited');
  });

  it('lets a same-NAME child skill override the parent', async () => {
    store.set('agents/child', { parent_agent: 'master' });
    store.set('agents/master/skills/m1', {
      name: 'outreach',
      status: 'active',
      priority: 1,
    });
    store.set('agents/child/skills/c1', {
      name: 'outreach',
      status: 'active',
      priority: 9,
    });

    const skills = await getSkillsForAgent('child');
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('override');
    expect(skills[0].priority).toBe(9);
  });

  it('marks an inactive override as inherited_disabled — the operator turned it off', async () => {
    store.set('agents/child', { parent_agent: 'master' });
    store.set('agents/master/skills/m1', {
      name: 'outreach',
      status: 'active',
    });
    store.set('agents/child/skills/c1', {
      name: 'outreach',
      status: 'inactive',
    });

    const skills = await getSkillsForAgent('child');
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('inherited_disabled');
    expect(skills[0].status).toBe('inactive');
  });

  it('keeps child-only skills alongside inherited ones', async () => {
    store.set('agents/child', { parent_agent: 'master' });
    store.set('agents/master/skills/m1', {
      name: 'outreach',
      status: 'active',
    });
    store.set('agents/child/skills/c1', { name: 'nurture', status: 'active' });

    const skills = await getSkillsForAgent('child');
    expect(skills.map((s) => [s.name, s.source]).sort()).toEqual([
      ['nurture', 'own'],
      ['outreach', 'inherited'],
    ]);
  });

  it('skips the agent read when the document is supplied', async () => {
    store.set('agents/child/skills/c1', { name: 'x', status: 'active' });
    // No agents/child document exists — passing agentData must still resolve the parent.
    store.set('agents/master/skills/m1', { name: 'y', status: 'active' });

    const skills = await getSkillsForAgent('child', { parent_agent: 'master' });
    expect(skills.map((s) => s.name).sort()).toEqual(['x', 'y']);
  });

  it('returns own skills when the agent document is missing entirely', async () => {
    store.set('agents/orphan/skills/s1', { name: 'x', status: 'active' });
    expect(await getSkillsForAgent('orphan')).toHaveLength(1);
  });
});

describe('withCanonicalStages', () => {
  it('always includes the full funnel plus terminal Lost', async () => {
    expect(withCanonicalStages([])).toEqual([
      'New',
      'Contacted',
      'Engaged',
      'Lead',
      'inspection_completed',
      'Pushed to CRM',
      'CRM Won',
      'Lost',
    ]);
  });

  it('injects inspection_completed directly after Lead', () => {
    const stages = withCanonicalStages([]);
    expect(stages[stages.indexOf('Lead') + 1]).toBe('inspection_completed');
  });

  it('preserves an agent custom stage just before Lost', () => {
    const stages = withCanonicalStages(['Demo Booked']);
    expect(stages[stages.length - 2]).toBe('Demo Booked');
    expect(stages[stages.length - 1]).toBe('Lost');
  });

  it('does not duplicate a canonical stage the agent also listed', () => {
    const stages = withCanonicalStages(['Lead', 'CRM Won', 'Lost']);
    expect(stages.filter((s) => s === 'Lead')).toHaveLength(1);
    expect(stages.filter((s) => s === 'Lost')).toHaveLength(1);
  });

  it('matches DEFAULT_STAGES for an empty input', () => {
    expect(withCanonicalStages(null)).toEqual([...DEFAULT_STAGES]);
  });
});

describe('getAvailableStages', () => {
  it('falls back to the parent when the agent has none', async () => {
    store.set('agents/child', { parent_agent: 'master' });
    store.set('agents/master', { available_stages: ['New', 'Demo Booked'] });
    const stages = await getAvailableStages('child');
    expect(stages).toContain('Demo Booked');
  });

  it('returns the canonical set for an unknown agent', async () => {
    expect(await getAvailableStages('nope')).toEqual([...DEFAULT_STAGES]);
  });
});

describe('getAgent', () => {
  it('backfills assigned_model from primary_model', async () => {
    store.set('agents/a1', { primary_model: 'us.anthropic.claude-x' });
    const agent = await getAgent('a1');
    expect(agent!.assigned_model).toBe('us.anthropic.claude-x');
  });

  it('backfills primary_model from assigned_model', async () => {
    store.set('agents/a1', { assigned_model: 'groq/oss-120b' });
    const agent = await getAgent('a1');
    expect(agent!.primary_model).toBe('groq/oss-120b');
  });

  it('falls back to the default model when neither is set', async () => {
    store.set('agents/a1', {});
    const agent = await getAgent('a1');
    expect(agent!.assigned_model).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    );
  });

  it('returns null for a missing agent', async () => {
    expect(await getAgent('nope')).toBeNull();
  });
});

describe('getAgentActions', () => {
  it('resolves active actions against the shared actions collection', async () => {
    store.set('agents/a1', {});
    store.set('agents/a1/actions/aa1', { status: 'active', action_id: 'act1' });
    store.set('actions/act1', {
      type: 'voice',
      action_prompt: 'call them',
      functions: ['make_phone_call'],
    });

    const actions = await getAgentActions('a1');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'voice',
      action_prompt: 'call them',
      functions: ['make_phone_call'],
    });
  });

  it('skips inactive actions', async () => {
    store.set('agents/a1', {});
    store.set('agents/a1/actions/aa1', {
      status: 'inactive',
      action_id: 'act1',
    });
    expect(await getAgentActions('a1')).toHaveLength(0);
  });

  it('defaults the fields when the shared action document is missing', async () => {
    store.set('agents/a1', {});
    store.set('agents/a1/actions/aa1', {
      status: 'active',
      action_id: 'ghost',
    });
    const actions = await getAgentActions('a1');
    expect(actions[0]).toMatchObject({
      type: '',
      action_prompt: '',
      functions: [],
    });
  });

  it('defaults the fields for an action with no action_id', async () => {
    store.set('agents/a1', {});
    store.set('agents/a1/actions/aa1', { status: 'active' });
    const actions = await getAgentActions('a1');
    expect(actions[0]).toMatchObject({
      type: '',
      action_prompt: '',
      functions: [],
    });
  });

  it('a subagent delegates wholesale to its lead agent', async () => {
    store.set('agents/sub', { type: 'subagent', lead_ai: 'lead1' });
    store.set('agents/lead1', {});
    store.set('agents/lead1/actions/aa1', {
      status: 'active',
      action_id: 'act1',
    });
    store.set('actions/act1', {
      type: 'email',
      action_prompt: 'p',
      functions: ['email'],
    });

    const actions = await getAgentActions('sub');
    expect(actions[0].functions).toEqual(['email']);
  });

  it('an oversee agent with no active actions inherits the parent', async () => {
    store.set('agents/ov', { oversee_agent: true, parent_agent: 'master' });
    store.set('agents/master', {});
    store.set('agents/master/actions/aa1', {
      status: 'active',
      action_id: 'act1',
    });
    store.set('actions/act1', {
      type: 'voice',
      action_prompt: 'p',
      functions: ['make_phone_call'],
    });

    const actions = await getAgentActions('ov');
    expect(actions[0].functions).toEqual(['make_phone_call']);
  });

  it('an oversee agent WITH its own active actions does not inherit', async () => {
    store.set('agents/ov', { oversee_agent: true, parent_agent: 'master' });
    store.set('agents/ov/actions/own', {
      status: 'active',
      action_id: 'actOwn',
    });
    store.set('actions/actOwn', {
      type: 'email',
      action_prompt: 'p',
      functions: ['email'],
    });
    store.set('agents/master/actions/aa1', {
      status: 'active',
      action_id: 'act1',
    });
    store.set('actions/act1', {
      type: 'voice',
      action_prompt: 'p',
      functions: ['make_phone_call'],
    });

    const actions = await getAgentActions('ov');
    expect(actions).toHaveLength(1);
    expect(actions[0].functions).toEqual(['email']);
  });

  it('returns [] for a missing agent', async () => {
    expect(await getAgentActions('nope')).toEqual([]);
  });
});

describe('getEnabledFunctionsForAgent', () => {
  it('deduplicates tool names across actions, preserving first-seen order', async () => {
    // Bedrock rejects a Converse call outright if a tool name appears twice in toolConfig, which is
    // exactly what two active action docs pointing at the same shared action would produce.
    store.set('agents/a1', {});
    store.set('agents/a1/actions/aa1', { status: 'active', action_id: 'act1' });
    store.set('agents/a1/actions/aa2', { status: 'active', action_id: 'act2' });
    store.set('actions/act1', { functions: ['make_phone_call', 'email'] });
    store.set('actions/act2', { functions: ['email', 'mark_prospect_lost'] });

    expect(await getEnabledFunctionsForAgent('a1')).toEqual([
      'make_phone_call',
      'email',
      'mark_prospect_lost',
    ]);
  });

  it('drops falsy entries', async () => {
    store.set('agents/a1', {});
    store.set('agents/a1/actions/aa1', { status: 'active', action_id: 'act1' });
    store.set('actions/act1', { functions: ['email', '', null] });
    expect(await getEnabledFunctionsForAgent('a1')).toEqual(['email']);
  });

  it('returns [] when the agent has no actions', async () => {
    store.set('agents/a1', {});
    expect(await getEnabledFunctionsForAgent('a1')).toEqual([]);
  });
});
