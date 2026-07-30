/**
 * Skills — the stage-driven prompt snippets and tool sets that shape each turn.
 *
 * A skill lives at `agents/{agentId}/skills/{skillId}` and declares a `trigger` (stages + optional
 * labels), a prompt fragment, and the tools it enables. Which skills are active for a turn is a
 * function of the prospect's stage and the chat's labels.
 *
 * Inheritance is by **name**, not id: an agent-level skill overrides a parent skill of the same
 * name, and an override with `status: 'inactive'` is how an operator *disables* an inherited skill
 * rather than deleting it. That is why the merge tracks names and why `source` is stamped on the
 * result (`own` / `override` / `inherited` / `inherited_disabled`) — the UI needs to explain where
 * each skill came from.
 *
 * This module is the raw reader. Outbound's stage/type filtering lives in
 * `services/skillsResolver.ts`, which always narrows to outbound-typed skills.
 */

import { db } from './db';
import { STAGE_ORDER } from './prospect';

/**
 * Default funnel stages, used when an agent has no custom `available_stages`.
 * Order mirrors the canonical funnel; `Lost` is terminal and stays last.
 */
export const DEFAULT_STAGES = [
  'New',
  'Contacted',
  'Engaged',
  'Lead',
  'inspection_completed',
  'Pushed to CRM',
  'CRM Won',
  'Lost',
] as const;

export interface SkillTrigger {
  stages?: string[];
  labels?: string[];
  require_all_labels?: boolean;
}

export interface Skill {
  id: string;
  agent_id?: string;
  name: string;
  status?: string;
  /** `'outbound'` | `'inbound'` | `'both'` | undefined. Outbound accepts `outbound` and `both`. */
  type?: string;
  /** Voice skills are injected into a call's prompt only, never the text/oversee toolset. */
  voice_skill?: boolean;
  priority?: number;
  trigger?: SkillTrigger;
  source?: 'own' | 'override' | 'inherited' | 'inherited_disabled';
  [k: string]: unknown;
}

/** Read every skill document in one agent's subcollection. */
async function readSkillsSubcollection(agentId: string): Promise<Skill[]> {
  try {
    const snap = await db
      .collection('agents')
      .doc(agentId)
      .collection('skills')
      .get();
    return snap.docs.map(
      (doc) =>
        ({ ...(doc.data() ?? {}), id: doc.id, agent_id: agentId }) as Skill
    );
  } catch (e) {
    console.error(`[SKILLS] Failed to read skills for ${agentId}: ${e}`);
    return [];
  }
}

/**
 * All skills for an agent, merged with its parent's.
 *
 * 1. Read the agent's own skills.
 * 2. If it has a `parent_agent`, read the parent's.
 * 3. Merge by **name** — an agent skill overrides the parent skill of the same name, and an
 *    override with `status: 'inactive'` disables the inherited one.
 *
 * @param agentData Optional pre-fetched agent document. When supplied the agent read is skipped —
 *   callers that already loaded the doc (e.g. the conversation-init webhook) pass it to avoid a
 *   redundant round trip.
 */
export async function getSkillsForAgent(
  agentId: string,
  agentData?: Record<string, unknown> | null
): Promise<Skill[]> {
  const agentSkills = await readSkillsSubcollection(agentId);

  let resolvedAgentData = agentData;
  if (resolvedAgentData === undefined || resolvedAgentData === null) {
    const agentDoc = await db.collection('agents').doc(agentId).get();
    if (!agentDoc.exists) return agentSkills;
    resolvedAgentData = agentDoc.data() ?? {};
  }

  const parentId = resolvedAgentData.parent_agent as string | undefined;
  if (!parentId) return agentSkills;

  const parentSkills = await readSkillsSubcollection(parentId);
  if (!parentSkills.length) return agentSkills;

  // Merge: the agent overrides the parent by name.
  const agentSkillNames = new Map<string, Skill>();
  for (const s of agentSkills) agentSkillNames.set(s.name, s);

  const merged: Skill[] = [];
  for (const ps of parentSkills) {
    const override = agentSkillNames.get(ps.name);
    if (override) {
      agentSkillNames.delete(ps.name);
      // `inactive` on an override is how an operator disables an inherited skill.
      override.source =
        override.status === 'inactive' ? 'inherited_disabled' : 'override';
      merged.push(override);
    } else {
      ps.source = 'inherited';
      merged.push(ps);
    }
  }

  // Anything left is an agent-only skill with no parent counterpart.
  for (const s of agentSkillNames.values()) {
    s.source = 'own';
    merged.push(s);
  }

  return merged;
}

/**
 * The agent's selectable stages, with the canonical funnel guaranteed present.
 *
 * `available_stages` only drives which stages a skill can be *triggered* on in the admin UI. The
 * platform sets the funnel stages itself, so they must be selectable for every agent — including
 * one that saved a custom `available_stages` array before a stage like `CRM Won` existed. Custom
 * stages the agent added are preserved, just before the terminal `Lost`.
 */
export async function getAvailableStages(agentId: string): Promise<string[]> {
  let base: string[] | null = null;
  const agentDoc = await db.collection('agents').doc(agentId).get();
  if (agentDoc.exists) {
    const data = agentDoc.data() ?? {};
    base = (data.available_stages ?? null) as string[] | null;
    if (!base || !base.length) {
      const parentId = data.parent_agent as string | undefined;
      if (parentId) {
        const parentDoc = await db.collection('agents').doc(parentId).get();
        if (parentDoc.exists) {
          base = ((parentDoc.data() ?? {}).available_stages ?? null) as
            | string[]
            | null;
        }
      }
    }
  }
  return withCanonicalStages(base && base.length ? base : [...DEFAULT_STAGES]);
}

/**
 * Guarantee the canonical funnel stages are present and selectable.
 *
 * `inspection_completed` is a platform stage that is deliberately NOT in the funnel order (so that
 * `inspection_completed → Lead` stays a legal forward transition), but it still has to be
 * triggerable, so it is injected right after `Lead`.
 */
export function withCanonicalStages(stages?: string[] | null): string[] {
  // The source imported STAGE_ORDER lazily to break a skills <-> prospect-analytics cycle. That
  // cycle does not exist here (prospect.ts imports nothing from this module), so a static import
  // is correct and avoids a runtime require in an ES module.
  const input = [...(stages ?? [])];
  const funnel = Object.keys(STAGE_ORDER).sort(
    (a, b) => STAGE_ORDER[a] - STAGE_ORDER[b]
  );
  const result = [...funnel];

  if (!result.includes('inspection_completed')) {
    const insertAt = result.includes('Lead')
      ? result.indexOf('Lead') + 1
      : result.length;
    result.splice(insertAt, 0, 'inspection_completed');
  }

  // Preserve any non-funnel custom stages the agent added (before `Lost`).
  for (const s of input) {
    if (!(s in STAGE_ORDER) && s !== 'Lost' && !result.includes(s))
      result.push(s);
  }

  result.push('Lost'); // terminal stage, always last
  return result;
}
