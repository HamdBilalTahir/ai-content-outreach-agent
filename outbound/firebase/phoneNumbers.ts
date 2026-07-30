/**
 * Phone-number lookups — the `phone_numbers` collection.
 *
 * Verbatim ports of the three lookups outbound actually uses, kept native so the outbound flow never
 * reaches into the inbound package for phone resolution. These map an ElevenLabs phone id, a raw
 * number, or an oversee-agent id onto the number document that owns it, which is what lets the
 * post-call webhook reconstruct the originating chat from durable data.
 *
 * All three are best-effort: `null` on any error, because a lookup miss must degrade to "unresolved"
 * rather than throw inside a webhook handler.
 */

import { type DocumentData, db } from './db';

/** A phone-number document by its ElevenLabs phone id. */
export async function getPhoneNumber(
  phoneNumberId: string
): Promise<DocumentData | null> {
  try {
    const phone = await db.collection('phone_numbers').doc(phoneNumberId).get();
    return phone.exists ? (phone.data() ?? null) : null;
  } catch (e) {
    console.error(`[OB_PHONE] getPhoneNumber failed: ${e}`);
    return null;
  }
}

/**
 * A phone-number document by the actual number string (`'+15074194359'`). The returned object
 * carries `id`, which callers need in order to reference the document.
 */
export async function getPhoneNumberByNumber(
  phoneNumber: string
): Promise<DocumentData | null> {
  try {
    const snap = await db
      .collection('phone_numbers')
      .where('phone_number', '==', phoneNumber)
      .limit(1)
      .get();
    for (const phone of snap.docs) {
      return { ...(phone.data() ?? {}), id: phone.id };
    }
    return null;
  } catch (e) {
    console.error(
      `[OB_PHONE] getPhoneNumberByNumber ${phoneNumber} failed: ${e}`
    );
    return null;
  }
}

/** The phone-number document linked to an oversee agent. */
export async function getPhoneNumberByOverseeAgentId(
  overseeAgentId: string
): Promise<DocumentData | null> {
  try {
    const snap = await db
      .collection('phone_numbers')
      .where('oversee_agent_id', '==', overseeAgentId)
      .limit(1)
      .get();
    for (const phone of snap.docs) return phone.data() ?? null;
    return null;
  } catch (e) {
    console.error(`[OB_PHONE] getPhoneNumberByOverseeAgentId failed: ${e}`);
    return null;
  }
}
