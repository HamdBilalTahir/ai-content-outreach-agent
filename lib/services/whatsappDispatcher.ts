import { Timestamp } from 'firebase-admin/firestore';
import { getLeadsByStatus, updateLeadStatus } from '../db/leads';
import { createDispatchLog } from '../db/dispatchLogs';

function maskNumber(number: string): string {
  return `****${number.slice(-4)}`;
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWhatsappMessage(
  whatsappNumber: string,
  message: string
): Promise<boolean> {
  const WEBHOOK_URL = process.env.WHATSAPP_WEBHOOK_URL;
  const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;

  if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
    console.error('Missing WHATSAPP_WEBHOOK_URL or WHATSAPP_WEBHOOK_SECRET');
    return false;
  }

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WEBHOOK_SECRET}`,
      },
      body: JSON.stringify({ to: whatsappNumber, message }),
    });

    if (response.ok) {
      console.log(`WhatsApp sent to ${maskNumber(whatsappNumber)}`);
      return true;
    }

    console.error(
      `WhatsApp send failed for ${maskNumber(whatsappNumber)}: HTTP ${response.status}`
    );
    return false;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `WhatsApp send error for ${maskNumber(whatsappNumber)}: ${detail}`
    );
    return false;
  }
}

import type { SystemSettings } from '../types';

export async function dispatchBatch(
  settings?: SystemSettings,
  leadIds?: string[],
  activePipelineIds?: string[]
): Promise<void> {
  if (!settings) {
    console.warn('dispatchBatch called without settings, skipping.');
    return;
  }
  if (!settings.dispatchEnabled) {
    console.log(
      'dispatchBatch: Dispatching is disabled in settings. Skipping.'
    );
    return;
  }

  const { getAllNiches } = await import('../db/niches');
  const niches = await getAllNiches(settings.userId);
  const nicheMap = new Map(niches.map((n) => [n.id, n]));

  let leads = await getLeadsByStatus(
    settings.userId,
    'Qualified',
    settings.dispatchBatchSize * 2 // Fetch more to allow filtering
  );

  if (activePipelineIds && activePipelineIds.length > 0) {
    leads = leads.filter((l) => activePipelineIds.includes(l.pipelineId));
  }

  if (leadIds && leadIds.length > 0) {
    // If specific leads are provided, filter the current leads or fetch them directly
    const { getLeadById } = await import('../db/leads');
    const specificLeads = [];
    for (const id of leadIds) {
      const l = await getLeadById(settings.userId, id);
      if (l && l.status === 'Qualified') specificLeads.push(l);
    }
    leads = specificLeads;
  }

  // Filter leads based on guardrails
  const filteredLeads = [];
  const dispatchCountPerNiche = new Map<string, number>();

  for (const lead of leads) {
    const niche = nicheMap.get(lead.nicheId);
    if (!niche) continue;

    const guardrails = niche.pipelineGuardrails;
    const minGapScore = guardrails?.minAiGapScore || 0;
    const maxDispatches =
      guardrails?.maxDailyDispatches || settings.dispatchBatchSize;

    if (lead.socialMediaGapScore < minGapScore) {
      continue; // Fails quality threshold
    }

    const currentCount = dispatchCountPerNiche.get(niche.id) || 0;
    if (currentCount >= maxDispatches) {
      continue; // Exceeds daily dispatch limit for this niche
    }

    filteredLeads.push(lead);
    dispatchCountPerNiche.set(niche.id, currentCount + 1);

    if (filteredLeads.length >= settings.dispatchBatchSize) {
      break;
    }
  }

  leads = filteredLeads;
  let sent = 0;
  let failed = 0;

  for (const lead of leads) {
    if (!lead.generatedPitch) {
      console.error(
        `dispatchBatch: skipping lead ${lead.id} — no generated pitch`
      );
      failed++;
      continue;
    }

    const success = await sendWhatsappMessage(
      lead.whatsappNumber,
      lead.generatedPitch
    );

    await createDispatchLog({
      userId: lead.userId,
      leadId: lead.id,
      whatsappNumber: lead.whatsappNumber,
      messageSent: lead.generatedPitch,
      success,
      errorMessage: success ? null : 'Send failed — see logs',
      attemptNumber: 1,
      dispatchedAt: Timestamp.now(),
    });

    await updateLeadStatus(
      settings.userId,
      lead.id,
      success ? 'Pitched' : 'Failed'
    );

    if (success) {
      sent++;
    } else {
      failed++;
    }

    await randomDelay(5_000, 10_000);
  }

  console.log(`dispatchBatch complete — sent: ${sent}, failed: ${failed}`);
}
