/**
 * Outbound skills resolution — turning a prospect's stage into a system prompt and a tool set.
 *
 * Outbound chats are always `type: "outbound"`, so this always filters to outbound-typed skills
 * (`outbound`, plus `both` for skills shared with inbound such as the Email Skill).
 *
 * ## The base prompt is WIPED for outbound
 *
 * `applySkillsToPrompt` resets the system prompt to `""` before applying skills. Outbound is
 * skills-only: the skills decide entirely what the agent says and which tools exist, and the agent's
 * configured actions only supply *how* to execute those tools. That reset is also why
 * `restoreWipedInjections` exists — anything injected before skills (the meeting-host fact, the
 * recent-conversation block) has to be put back afterwards.
 *
 * ## Voice skills are excluded from the text prompt
 *
 * A skill flagged `voice_skill` runs on voice calls exclusively: it is injected into the call's
 * `{{skills}}` variable by `buildSkillsText`, and must never appear in the text/oversee prompt or
 * toolset. Leaking one into the text prompt would have the agent narrate call scripting over email.
 */

import { db } from '../firebase/db';
import { getSkillsForAgent, type Skill } from '../firebase/skills';
import type { ChatMemory } from '../types';

/**
 * The outbound twin of the shared stage resolver, narrowed to outbound-typed skills.
 *
 * Filters by `status: 'active'`, then type (`outbound` or `both`), then a `trigger.stages` match,
 * then optional `trigger.labels` (all-of when `require_all_labels`, else any-of). Sorted by
 * `priority` descending, so a higher number wins when two skills overlap.
 */
export async function getActiveOutboundSkillsForStage(
  agentId: string,
  stage: string,
  labels: string[] = [],
  agentData?: Record<string, unknown> | null
): Promise<Skill[]> {
  const allSkills = (await getSkillsForAgent(agentId, agentData)) ?? [];
  const active: Skill[] = [];

  for (const skill of allSkills) {
    if (skill.status !== 'active') continue;
    if (skill.type !== 'outbound' && skill.type !== 'both') continue;

    const trigger = skill.trigger ?? {};
    const triggerStages = trigger.stages ?? [];
    if (!triggerStages.includes(stage)) continue;

    const triggerLabels = trigger.labels ?? [];
    if (triggerLabels.length) {
      if (trigger.require_all_labels) {
        if (!triggerLabels.every((l) => labels.includes(l))) continue;
      } else if (!triggerLabels.some((l) => labels.includes(l))) {
        continue;
      }
    }
    active.push(skill);
  }

  active.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return active;
}

/**
 * Apply stage-driven skills to the system prompt and tool set.
 *
 * For outbound the base prompt is reset to `""` and only outbound-typed skills are applied.
 * **Mutates `enabledFunctions` in place** — the caller holds the array the tool loop will read.
 * Returns `[systemPrompt, skillEnabledTools]`.
 *
 * `tools_to_disable` is applied after `tools_to_enable` within each skill, so a later skill can
 * remove a tool an earlier one added.
 */
export function applySkillsToPrompt(
  systemPrompt: string,
  activeSkills: Skill[] | null | undefined,
  enabledFunctions: string[],
  chatType = 'outbound'
): [string, Set<string>] {
  const isOutbound = chatType === 'outbound';
  let prompt = isOutbound ? '' : systemPrompt;
  const skillEnabledTools = new Set<string>();

  for (const skill of activeSkills ?? []) {
    // Voice skills belong to the call only — never the text/oversee prompt or toolset.
    if (skill.voice_skill) continue;

    const stype = skill.type;
    // `both` applies to either chat type; `outbound` only to outbound; untyped/`inbound` only to
    // non-outbound.
    if (isOutbound && stype !== 'outbound' && stype !== 'both') continue;
    if (!isOutbound && stype === 'outbound') continue;

    const instructions = String(skill.instructions ?? '');
    if (instructions) {
      prompt = prompt ? `${prompt}\n\n${instructions}` : instructions;
    }

    for (const tool of (skill.tools_to_enable ?? []) as string[]) {
      if (!enabledFunctions.includes(tool)) enabledFunctions.push(tool);
      skillEnabledTools.add(tool);
    }
    for (const tool of (skill.tools_to_disable ?? []) as string[]) {
      const idx = enabledFunctions.indexOf(tool);
      if (idx >= 0) enabledFunctions.splice(idx, 1);
    }
  }

  return [prompt, skillEnabledTools];
}

/**
 * Re-prepend the meeting-host fact and the recent-conversation block after `applySkillsToPrompt` has
 * reset the outbound base prompt.
 *
 * Both are injected *before* skills so they also serve non-outbound chats (whose prompt is not
 * reset); for outbound the reset wipes them, so this puts them back. Host first, then the recent
 * block — which leaves the recent conversation at the very top, where it is most salient for a
 * "read the inbound email and reply" turn. No-op for empty inputs.
 */
export function restoreWipedInjections(
  systemPrompt: string,
  hostFact = '',
  recentBlock = ''
): string {
  let prompt = systemPrompt;
  if (hostFact) prompt = `${hostFact}\n\n${prompt}`;
  if (recentBlock) prompt = `${recentBlock}\n\n${prompt}`;
  return prompt;
}

/**
 * Keep only the configured actions that supply execution for a currently-enabled tool.
 *
 * Outbound is skills-only: skills decide WHICH tools exist, the agent's config actions only supply
 * HOW to execute them. So of N configured actions, keep just those whose `functions` intersect
 * `enabledFunctions`. Pure; returns a new array.
 */
export function scopeActionsToEnabledTools<T extends { functions?: string[] }>(
  agentActions: T[] | null | undefined,
  enabledFunctions: readonly string[] | null | undefined
): T[] {
  const enabled = new Set(enabledFunctions ?? []);
  return (agentActions ?? []).filter((a) =>
    (a.functions ?? []).some((f) => enabled.has(f))
  );
}

/**
 * Replace `{{variable}}` / `{{var\_name}}` / `{var_name}` placeholders from memory.
 *
 * The escaped form exists because the admin UI stores skill text where an underscore may have been
 * markdown-escaped. Internal keys (leading `_`) are skipped — they are code-owned markers and must
 * never leak into a customer-facing prompt.
 */
export function replaceTemplateVariables(
  text: string,
  memory: ChatMemory | Record<string, unknown> | null | undefined
): string {
  if (!text || !memory) return text;
  let out = text;
  for (const [key, rawVal] of Object.entries(memory)) {
    if (rawVal === null || rawVal === undefined) continue;
    if (typeof key !== 'string' || key.startsWith('_')) continue;
    const val = typeof rawVal === 'string' ? rawVal : String(rawVal);
    const escapedKey = key.replace(/_/g, '\\_');
    out = out
      .split(`{{${escapedKey}}}`)
      .join(val)
      .split(`{{${key}}}`)
      .join(val)
      .split(`{${key}}`)
      .join(val);
  }
  return out;
}

export interface ResolvedSkills {
  stage: string;
  activeSkills: Skill[];
  labels: string[];
  chatMemory: ChatMemory;
}

/**
 * Resolve the current stage and load the matching outbound skills.
 *
 * Defaults to stage `New` with no labels, which is what an absent or unreadable chat resolves to —
 * the agent still gets its first-touch skill rather than no skill at all. `chatData` may be passed in
 * by a caller that already loaded the document, to skip the read.
 */
export async function resolveStageAndSkills(
  chatId: string,
  agentId: string,
  chatData?: Record<string, unknown> | null,
  agentData?: Record<string, unknown> | null
): Promise<ResolvedSkills> {
  let stage = 'New';
  let labels: string[] = [];
  let chatMemory: ChatMemory = {};

  const withDefaults = async (): Promise<ResolvedSkills> => ({
    stage,
    activeSkills: await getActiveOutboundSkillsForStage(
      agentId,
      stage,
      labels,
      agentData
    ),
    labels,
    chatMemory,
  });

  try {
    if (!chatId) return withDefaults();

    let data = chatData;
    if (data === undefined) {
      const doc = await db.collection('chats').doc(chatId).get();
      if (!doc.exists) return withDefaults();
      data = doc.data() ?? {};
    }
    if (!data || !Object.keys(data).length) return withDefaults();

    chatMemory = (data.memory ?? {}) as ChatMemory;
    stage = String(data.stage ?? 'New');
    labels = (data.labels ?? []) as string[];

    return {
      stage,
      activeSkills: await getActiveOutboundSkillsForStage(
        agentId,
        stage,
        labels,
        agentData
      ),
      labels,
      chatMemory,
    };
  } catch (e) {
    console.warn(
      `[OB SkillsResolver] Failed for chat=${chatId}, agent=${agentId}: ${e}`
    );
    return { stage, activeSkills: [], labels, chatMemory };
  }
}

/**
 * The concatenated skill instructions with `{{variable}}` placeholders resolved from chat memory —
 * used for the voice agent's dynamic variables. `null` when no skill applies.
 *
 * With `requireVoiceLabel = true` (the voice-call path) only skills flagged `voice_skill` are
 * included. Skills without the flag are text skills and never reach the voice agent.
 */
export async function buildSkillsText(
  chatId: string,
  agentId: string,
  chatData?: Record<string, unknown> | null,
  agentData?: Record<string, unknown> | null,
  requireVoiceLabel = false
): Promise<string | null> {
  const { activeSkills, chatMemory } = await resolveStageAndSkills(
    chatId,
    agentId,
    chatData,
    agentData
  );
  if (!activeSkills.length) return null;

  let skills = activeSkills;
  if (requireVoiceLabel) {
    skills = skills.filter((s) => s.voice_skill);
    if (!skills.length) return null;
  }

  const parts = skills
    .map((s) => String(s.instructions ?? ''))
    .filter((s) => s.length > 0);
  if (!parts.length) return null;

  let combined = parts.join('\n\n');
  if (chatMemory && Object.keys(chatMemory).length) {
    combined = replaceTemplateVariables(combined, chatMemory);
  }
  return combined;
}
