import { NextResponse } from 'next/server';

import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';
import { isArchivedChat } from '@/lib/utils';

// Converted (attributed-to-deal) chats for an agent, via the Admin SDK. The
// client filters these by the won-stage ids it already gets from deal-funnel.
//
//   GET ?agent_id= -> { deals: [{ chatId, name, company, phone, stageLabel,
//                                 hubspotDealStageId, createdAt, convertedAt }] }

const toIso = (v: any): string | null => {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
};

/**
 * Ported from the admin panel with the same three substitutions as the funnel routes in U4:
 * `auth()` → `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes and serialization are the source's.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const agentId = new URL(request.url).searchParams.get('agent_id');
  if (!agentId) {
    return NextResponse.json({ error: 'agent_id required' }, { status: 400 });
  }

  try {
    const snap = await adminDb
      .collection('chats')
      .where('memory._converted_to_deal', '==', true)
      .get();
    const deals = snap.docs
      .map((d) => ({ id: d.id, c: d.data() as any }))
      .filter(({ c }) => {
        if (String(c.agentId ?? '') !== agentId) return false;
        if (c.record_type === 'Test') return false;
        if (isArchivedChat(c)) return false;
        return true;
      })
      .map(({ id, c }) => {
        const m = c.memory ?? {};
        return {
          chatId: id,
          name:
            [m.first_name, m.last_name].filter(Boolean).join(' ') ||
            c.display_name ||
            m.display_name ||
            m.contact_name ||
            m.phone ||
            c.phone ||
            id,
          company: m.company || c.company || m.company_name || null,
          phone: m.phone || c.phone || c.userId || null,
          stageLabel: m.hubspot_deal_stage ?? c.stage ?? null,
          hubspotDealStageId: String(m._hubspot_deal_stage_id ?? ''),
          createdAt: toIso(c.createdAt ?? c.created_at),
          convertedAt: toIso(m._hubspot_deal_converted_at),
        };
      });
    return NextResponse.json({ deals });
  } catch (error: any) {
    console.error('[outbound/attribution/deals] GET error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
