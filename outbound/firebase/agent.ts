/**
 * Agent document access — the configuration every LLM turn is built from.
 *
 * An `agents/{agentId}` document holds the model assignment, the `actions` subcollection (which
 * resolves to the enabled tool list), knowledge sources, lead stages, and memory-key declarations.
 *
 * Two inheritance rules run through all of this and are easy to lose:
 *
 *  - **`type === 'subagent'`** delegates wholesale to the agent named in `lead_ai`.
 *  - **`oversee_agent === true`** inherits from `parent_agent`, but only when the child has nothing
 *    of its own. Partial data on the child means the child wins outright — it does not merge.
 */

import {
  db,
  getAllChunked,
  type DocumentData,
  type DocumentReference,
} from './db';

/** Matches the source's fallback when an agent document names no model. */
export const DEFAULT_PRIMARY_MODEL =
  'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface AgentAction {
  id: string;
  status?: string;
  action_id?: string;
  type?: string;
  action_prompt?: string;
  functions?: string[];
  [k: string]: unknown;
}

export interface AgentPromptData {
  knowledge_sources: string | null;
  lead_stages: string | null;
  memory_keys: string | null;
  lead_id: string;
}

/**
 * Keep model config backward-compatible across the old and new field names.
 * `primary_model` is the source of truth; `assigned_model` is the API/UI alias. Whichever is
 * present fills in the other, so downstream code can read either.
 */
function normalizeAgentModelFields(agentData: DocumentData): DocumentData {
  if (agentData === null || typeof agentData !== 'object') return agentData;

  const resolvedModel =
    agentData.assigned_model ||
    agentData.primary_model ||
    DEFAULT_PRIMARY_MODEL;

  if (resolvedModel) {
    if (!agentData.assigned_model) agentData.assigned_model = resolvedModel;
    if (!agentData.primary_model) agentData.primary_model = resolvedModel;
  }
  return agentData;
}

/** Fetch an agent document by id, or `null`. */
export async function getAgent(agentId: string): Promise<DocumentData | null> {
  try {
    const snap = await db.collection('agents').doc(agentId).get();
    if (!snap.exists) return null;
    return normalizeAgentModelFields(snap.data() ?? {});
  } catch (e) {
    console.log(`Error getting agent: ${e}`);
    return null;
  }
}

/**
 * Resolve an agent's ACTIVE actions, each populated with the `type`, `action_prompt` and
 * `functions` from the shared `actions/{actionId}` document it points at.
 *
 * The two-pass shape is a performance requirement, not a style choice: the first pass collects the
 * shared-action references, then one batched `getAll` fetches them together. Reading them one at a
 * time inside the loop was measured at ~8.5s for a typical agent.
 *
 * Inheritance: a `subagent` delegates to `lead_ai`; an `oversee_agent` with no active actions of
 * its own delegates to `parent_agent`.
 */
export async function getAgentActions(agentId: string): Promise<AgentAction[]> {
  try {
    const agent = await getAgent(agentId);
    if (!agent) return [];

    if ((agent.type ?? 'agent') === 'subagent') {
      return getAgentActions(String(agent.lead_ai ?? ''));
    }

    const actionsSnap = await db
      .collection('agents')
      .doc(agentId)
      .collection('actions')
      .get();

    const activeActionsData: AgentAction[] = [];
    const actionRefsToFetch: DocumentReference[] = [];

    for (const actionDoc of actionsSnap.docs) {
      const actionData = {
        ...(actionDoc.data() ?? {}),
        id: actionDoc.id,
      } as AgentAction;
      if (actionData.status !== 'active') continue;

      if (actionData.action_id) {
        actionRefsToFetch.push(
          db.collection('actions').doc(String(actionData.action_id))
        );
      } else {
        actionData.type = '';
        actionData.action_prompt = '';
        actionData.functions = [];
      }
      activeActionsData.push(actionData);
    }

    // An oversee agent with nothing active of its own inherits the parent's actions wholesale.
    if (agent.oversee_agent === true && activeActionsData.length === 0) {
      const parentId = String(agent.parent_agent ?? '');
      return parentId ? getAgentActions(parentId) : [];
    }

    const mainActionsDict: Record<
      string,
      { type: string; action_prompt: string; functions: string[] }
    > = {};

    if (actionRefsToFetch.length) {
      try {
        for (const doc of await getAllChunked(actionRefsToFetch)) {
          if (doc.exists) {
            const d = doc.data() ?? {};
            mainActionsDict[doc.id] = {
              type: String(d.type ?? ''),
              action_prompt: String(d.action_prompt ?? ''),
              functions: (d.functions ?? []) as string[],
            };
          } else {
            console.warn(
              `[getAgentActions] Main action document ${doc.id} does not exist`
            );
          }
        }
      } catch (e) {
        // Fail-open with empty values rather than losing the whole action list.
        console.error(`[getAgentActions] Error in batch fetch: ${e}`);
      }
    }

    for (const actionData of activeActionsData) {
      const actionId = actionData.action_id ? String(actionData.action_id) : '';
      if (actionId && mainActionsDict[actionId]) {
        const main = mainActionsDict[actionId];
        actionData.type = main.type;
        actionData.action_prompt = main.action_prompt;
        actionData.functions = main.functions;
      } else if (actionId) {
        console.warn(
          `[getAgentActions] Main action data not found for action_id=${actionId}, setting defaults`
        );
        actionData.type = '';
        actionData.action_prompt = '';
        actionData.functions = [];
      }
    }

    return activeActionsData;
  } catch (e) {
    console.error(`[getAgentActions] Error getting agent actions: ${e}`);
    return [];
  }
}

/**
 * The enabled tool names for an agent, gathered from its active actions.
 *
 * **Duplicates must be dropped.** Two active action documents can point at the same shared action
 * (e.g. the admin panel created a second subcollection doc instead of editing the first), and
 * Bedrock rejects a Converse call outright if the same tool name appears twice in `toolConfig`.
 * Original order is preserved otherwise.
 */
export async function getEnabledFunctionsForAgent(
  agentId: string
): Promise<string[]> {
  try {
    const agentActions = await getAgentActions(agentId);
    const enabledFunctions: string[] = [];
    const seen = new Set<string>();

    for (const action of agentActions) {
      for (const fn of action.functions ?? []) {
        if (fn && !seen.has(fn)) {
          seen.add(fn);
          enabledFunctions.push(fn);
        }
      }
    }
    return enabledFunctions;
  } catch (e) {
    console.error(
      `[getEnabledFunctionsForAgent] Error for agent ${agentId}: ${e}`
    );
    return [];
  }
}

/** All knowledge-source documents belonging to an agent, each with its `id`. */
export async function getKnowledgeSourcesByAgent(
  agentId: string
): Promise<DocumentData[]> {
  try {
    const snap = await db
      .collection('knowledge_sources')
      .where('agent_id', '==', agentId)
      .get();
    return snap.docs.map((d) => ({ ...(d.data() ?? {}), id: d.id }));
  } catch (e) {
    console.log(`Error getting knowledge sources by agent: ${e}`);
    return [];
  }
}

/**
 * Render an agent's knowledge sources into the block the system prompt embeds.
 * `product_images_with_meta` sources are skipped — they are consumed by the image path, and their
 * payload would flood the prompt.
 */
function formatKnowledgeSources(sources: DocumentData[]): string[] {
  const formatted: string[] = [];
  for (const source of sources) {
    const sourceType = String(source.type ?? 'text');
    if (sourceType === 'product_images_with_meta') continue;
    formatted.push(
      `firebase knowledge source ID: ${source.id}\nName: ${source.name}\n` +
        `Type: ${sourceType}\nData: ${source.data}\n`
    );
  }
  return formatted;
}

/** The knowledge-source block for the system prompt, or `''` on failure. */
export async function getFormattedKnowledgeSources(
  agentId: string
): Promise<string> {
  try {
    const sources = await getKnowledgeSourcesByAgent(agentId);
    return formatKnowledgeSources(sources).join('\n');
  } catch (e) {
    console.log(`Error formatting knowledge sources: ${e}`);
    return '';
  }
}

/**
 * Fetch the agent once and return every prompt-related block from it.
 *
 * The `include*` flags exist for latency-sensitive callers: knowledge sources cost an extra query,
 * so a turn that does not need them can skip it.
 */
export async function getAgentDataForPrompt(
  agentId: string,
  includeKnowledgeSources = true,
  includeLeadStages = true,
  includeMemoryKeys = true
): Promise<AgentPromptData> {
  const empty = (): AgentPromptData => ({
    knowledge_sources: null,
    lead_stages: null,
    memory_keys: null,
    lead_id: '',
  });

  try {
    const agent = await getAgent(agentId);
    if (!agent) {
      console.log(`Agent ${agentId} not found`);
      return empty();
    }

    // A subagent has no prompt data of its own — it delegates to its lead agent.
    if ((agent.type ?? 'agent') === 'subagent') {
      const leadId = String(agent.lead_ai ?? '');
      if (!leadId) return empty();
      const leadAgentData = await getAgentDataForPrompt(
        leadId,
        includeKnowledgeSources,
        includeLeadStages,
        includeMemoryKeys
      );
      leadAgentData.lead_id = leadId;
      return leadAgentData;
    }

    // An oversee agent inherits from its parent only when it has NOTHING of its own. Any own data
    // means the child wins outright — deliberately not a merge.
    if (agent.oversee_agent === true) {
      const parentId = String(agent.parent_agent ?? '');
      const hasLeadStages =
        includeLeadStages &&
        Boolean(((agent.lead_stages ?? []) as unknown[]).length);
      const hasMemoryKeys =
        includeMemoryKeys &&
        Boolean(((agent.memory_keys ?? []) as unknown[]).length);
      let hasKnowledge = false;
      if (includeKnowledgeSources) {
        try {
          hasKnowledge = Boolean(
            (await getKnowledgeSourcesByAgent(agentId)).length
          );
        } catch {
          // Treated as "no knowledge" — the inheritance check must not throw.
        }
      }

      if (!hasLeadStages && !hasMemoryKeys && !hasKnowledge && parentId) {
        return getAgentDataForPrompt(
          parentId,
          includeKnowledgeSources,
          includeLeadStages,
          includeMemoryKeys
        );
      }
      // Otherwise fall through and build from the agent's own data.
    }

    const result: AgentPromptData = {
      knowledge_sources: null,
      lead_stages: null,
      memory_keys: null,
      lead_id: String(agent.lead_ai ?? ''),
    };

    if (includeKnowledgeSources) {
      try {
        const formatted = formatKnowledgeSources(
          await getKnowledgeSourcesByAgent(agentId)
        );
        result.knowledge_sources = formatted.length
          ? formatted.join('\n')
          : 'No knowledge sources found';
      } catch (e) {
        console.log(
          `Error getting knowledge sources for agent ${agentId}: ${e}`
        );
        result.knowledge_sources = 'No knowledge sources found';
      }
    }

    if (includeLeadStages) {
      const leadStages = (agent.lead_stages ?? []) as string[];
      if (leadStages.length) {
        result.lead_stages = `Available stages: ${leadStages.map((s) => `'${s}'`).join(', ')}`;
      }
    }

    if (includeMemoryKeys) {
      const memoryKeys = (agent.memory_keys ?? []) as Array<
        Record<string, unknown>
      >;
      if (memoryKeys.length) {
        const formattedKeys = memoryKeys.map((key) => {
          const name = String(key.name ?? 'unknown');
          const keyType = String(key.type ?? 'string');
          const description = String(key.description ?? '');
          const enumValues = (key.enum_values ?? []) as string[];

          let keyDesc = `  - ${name} (${keyType})`;
          if (description) keyDesc += `: ${description}`;
          if (enumValues.length) {
            keyDesc += ` [Options: ${enumValues.map((v) => `'${v}'`).join(', ')}]`;
          }
          return keyDesc;
        });
        result.memory_keys = `Available memory keys for memory management:\n${formattedKeys.join('\n')}`;
      }
    }

    return result;
  } catch (e) {
    console.log(
      `Error getting agent data for prompt for agent ${agentId}: ${e}`
    );
    return empty();
  }
}

/** The voice-agent binding on an agent document, or `null` when the agent is missing. */
export async function getVoiceAgentConfig(agentId: string): Promise<{
  voice_agent_assistant_id: string | undefined;
  voice_agent_phone_number_id: string | undefined;
  voice_ai_provider: string;
} | null> {
  try {
    const agent = await getAgent(agentId);
    if (!agent) {
      console.log(`Agent ${agentId} not found`);
      return null;
    }
    return {
      voice_agent_assistant_id: agent.voice_agent_assistant_id as
        | string
        | undefined,
      voice_agent_phone_number_id: agent.voice_agent_phone_number_id as
        | string
        | undefined,
      voice_ai_provider: String(agent.voice_ai_provider ?? 'vapi'),
    };
  } catch (e) {
    console.log(`Error getting voice agent config for agent ${agentId}: ${e}`);
    return null;
  }
}

/**
 * Assemble an agent's system prompt from its four Firestore sections.
 *
 * The four headed sections (`PERSONA OF AI AGENT`, `ROLES AND RESPONSIBILITIES`, `GUARDRAILS`,
 * `ADDITIONAL INSTRUCTIONS`) are emitted even when empty — the headings are part of the contract the
 * prompts are written against, so dropping empty ones would change what every agent sees.
 *
 * Two inheritance rules, both recursive:
 *  - An **oversee agent** with any section of its own uses it; with ALL four empty it inherits its
 *    parent's prompt wholesale. Empty-and-parentless still returns the bare section skeleton, not null,
 *    so a misconfigured agent gets a valid (if useless) prompt rather than a crash.
 *  - A **subagent** takes its lead agent's prompt and appends its own goal and workflow instructions.
 *
 * `null` only when the agent does not exist or the read fails.
 */
export async function getAgentPrompt(
  agentId: string,
  depth = 0
): Promise<string | null> {
  // Recursion is data-driven (parent_agent / lead_ai), so a misconfigured cycle must not hang a turn.
  if (depth > 5) {
    console.warn(`[OB] getAgentPrompt: inheritance too deep at ${agentId}`);
    return null;
  }
  try {
    const agent = await getAgent(agentId);
    if (!agent) return null;

    const sections = (a: DocumentData) =>
      'PERSONA OF AI AGENT\n' +
      `${a.persona ?? ''}` +
      '\nROLES AND RESPONSIBILITIES\n' +
      `${a.prompt ?? ''}` +
      '\nGUARDRAILS\n' +
      `${a.guardrails ?? ''}` +
      '\nADDITIONAL INSTRUCTIONS\n' +
      `${a.additional_instructions ?? ''}`;

    if (agent.oversee_agent === true) {
      const hasOwn = !!(
        agent.persona ||
        agent.prompt ||
        agent.guardrails ||
        agent.additional_instructions
      );
      if (hasOwn) return sections(agent);
      const parentId = String(agent.parent_agent ?? '');
      if (parentId) return getAgentPrompt(parentId, depth + 1);
      return sections(agent);
    }

    if (agent.type === 'subagent') {
      const leadPrompt =
        (await getAgentPrompt(String(agent.lead_ai ?? ''), depth + 1)) ?? '';
      return (
        `${leadPrompt}` +
        '\nIMPORTANT: BASED ON ABOVE, RUN FOLLOWING WORKFLOW WITHOUT ERRORS. GOAL IS\n' +
        `${agent.goals ?? ''}\n` +
        'INSTRUCTIONS TO RUN WORKFLOW\n' +
        `${agent.instructions ?? ''}`
      );
    }

    return sections(agent);
  } catch (e) {
    console.log(`Error getting agent prompt: ${e}`);
    return null;
  }
}

/**
 * Persist refreshed OAuth credentials onto an agent's action.
 *
 * Written after every token refresh so the next call reuses the new access token instead of spending
 * another refresh round-trip — and so the rotated refresh token survives, since providers may issue a
 * new one and invalidate the old.
 */
export async function updateAgentActionAuth(
  agentId: string,
  actionId: string,
  authData: Record<string, unknown>
): Promise<boolean> {
  try {
    if (!agentId || !actionId) {
      console.log(
        `Missing required fields - agent_id: ${agentId}, action_id: ${actionId}`
      );
      return false;
    }
    await db
      .collection('agents')
      .doc(agentId)
      .collection('actions')
      .doc(actionId)
      .set({ auth: authData }, { merge: true });
    return true;
  } catch (e) {
    console.log(`Error updating agent action auth: ${e}`);
    return false;
  }
}
