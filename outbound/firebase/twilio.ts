/**
 * Twilio credential resolution — the two reads the CNAM lookup needs.
 *
 * Credentials live in two collections: `twilio_sms_accounts` links an agent to a connection, and
 * `twilio_connections` holds the actual `{account_sid, auth_token}`. Only the read path outbound uses
 * is ported; the inbound module's management/write helpers are not outbound's concern.
 *
 * Note this returns the UNMASKED `auth_token`, unlike the inbound company-scoped listing which masks
 * it for display. That is required — the value is used to sign an API request, not shown to anyone.
 */

import { type DocumentData, db } from './db';

/** Every SMS account for an agent, each carrying its document `id`. */
export async function getSmsAccountsByAgent(
  agentId: string
): Promise<DocumentData[]> {
  if (!agentId) return [];
  try {
    const snap = await db
      .collection('twilio_sms_accounts')
      .where('agent_id', '==', agentId)
      .get();
    return snap.docs.map((a) => ({ ...(a.data() ?? {}), id: a.id }));
  } catch (e) {
    console.warn(`[OB_TWILIO] getSmsAccountsByAgent ${agentId} failed: ${e}`);
    return [];
  }
}

/** A Twilio connection by id, or `null`. */
export async function getTwilioConnection(
  connectionId: string | null | undefined
): Promise<DocumentData | null> {
  if (!connectionId) return null;
  try {
    const doc = await db
      .collection('twilio_connections')
      .doc(String(connectionId))
      .get();
    return doc.exists ? (doc.data() ?? null) : null;
  } catch (e) {
    console.warn(
      `[OB_TWILIO] getTwilioConnection ${String(connectionId)} failed: ${e}`
    );
    return null;
  }
}
