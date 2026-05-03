import { Timestamp } from 'firebase-admin/firestore';
import { getLeadsByStatus, updateLead } from '../db/leads';
import { createDispatchLog } from '../db/dispatchLogs';

function maskNumber(number: string): string {
  return `****${number.slice(-4)}`;
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import {
  sendWhatsappMessage as unipileSendMessage,
  getConnectedAccounts,
} from './unipile';

import { getPrimaryConnection } from '../db/connections';

export async function sendWhatsappMessage(
  userId: string,
  whatsappNumber: string,
  message: string
): Promise<boolean> {
  const primaryConnection = await getPrimaryConnection(userId);
  if (!primaryConnection || !primaryConnection.instanceId) {
    console.error(
      `[WhatsApp Dispatcher] No primary connection found for user ${userId}`
    );
    return false;
  }

  console.log(
    `[WhatsApp Dispatcher] Sending message to ${maskNumber(whatsappNumber)} via account ${primaryConnection.instanceId}`
  );

  // Note: we let this throw directly back up to dispatchBatch so we can properly capture
  // explicit Number Not on WhatsApp errors and mark the lead as invalid.
  return await unipileSendMessage(
    primaryConnection.instanceId,
    whatsappNumber,
    message
  );
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

  let leads: any[] = [];

  if (leadIds && leadIds.length > 0) {
    // If specific leads are provided, fetch them directly
    const { getLeadById } = await import('../db/leads');
    for (const id of leadIds) {
      const l = await getLeadById(settings.userId, id);
      if (l) leads.push(l);
    }
  } else {
    // Standard cron batch pull
    leads = await getLeadsByStatus(
      settings.userId,
      'Qualified',
      settings.dispatchBatchSize * 2 // Fetch more to allow filtering
    );
  }

  // Let's just filter leads we fetched to exclude rejected ones
  // We'll also only include those explicitly approved or standard 'Qualified'
  leads = leads.filter(
    (l) =>
      (l.dispatchStatus as any) !== 'rejected' &&
      (l.dispatchStatus === 'approved' || l.status === 'Qualified')
  );

  if (activePipelineIds && activePipelineIds.length > 0) {
    leads = leads.filter((l) => activePipelineIds.includes(l.pipelineId));
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

    let success = false;
    let errorMessage: string | null = null;
    let finalStatus: any = 'Failed';

    try {
      success = await sendWhatsappMessage(
        settings.userId,
        lead.whatsappNumber,
        lead.generatedPitch
      );
      if (success) {
        finalStatus = 'Pitched';
      } else {
        errorMessage = 'Send failed — see logs';
      }
    } catch (err: any) {
      success = false;
      errorMessage = err.message || 'Send failed';
      if (errorMessage === 'Number not on WhatsApp') {
        finalStatus = 'Number Invalid';
      }
    }

    // We actually handled the error logging in sendWhatsappMessage, but if it threw up to here we handle it.
    // Notice that sendWhatsappMessage catches and returns false if it's not our explicit throw

    await createDispatchLog({
      userId: lead.userId,
      leadId: lead.id,
      whatsappNumber: lead.whatsappNumber,
      messageSent: lead.generatedPitch,
      success,
      errorMessage,
      attemptNumber: 1,
      dispatchedAt: Timestamp.now(),
    });

    await updateLead(settings.userId, lead.id, {
      status: finalStatus,
      dispatchSuccess: success,
      lastMessageSent: lead.generatedPitch,
      lastMessageSentAt: Timestamp.now(),
    });

    if (success) {
      sent++;
    } else {
      failed++;
    }

    await randomDelay(5_000, 10_000);
  }

  console.log(`dispatchBatch complete — sent: ${sent}, failed: ${failed}`);
}
