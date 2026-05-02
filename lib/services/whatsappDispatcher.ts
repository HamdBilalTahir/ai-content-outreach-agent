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

export async function dispatchBatch(settings?: SystemSettings): Promise<void> {
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

  const leads = await getLeadsByStatus(
    settings.userId,
    'Qualified',
    settings.dispatchBatchSize
  );
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
