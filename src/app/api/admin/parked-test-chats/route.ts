import { NextResponse } from 'next/server';
import { db as adminDb } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

// Read-only list of parked E2E test chats (the `e2e_test_chats` collection).
// Each archived chat is its own card — no dedup, even when names collide,
// since the doc id is what's unique.

function str(v: any): string {
  if (v === null || v === undefined) return '';
  const t = typeof v === 'string' ? v.trim() : String(v).trim();
  const low = t.toLowerCase();
  return low === 'null' || low === 'undefined' || low === 'n/a' ? '' : t;
}

function displayName(data: any): string {
  const m = data.memory || {};
  const direct =
    str(data.display_name) ||
    str(m.display_name) ||
    str(data.name) ||
    str(m.name) ||
    str(data.customer_name) ||
    str(m.customer_name);
  if (direct) return direct;
  const first = str(m.first_name) || str(data.first_name);
  const last = str(m.last_name) || str(data.last_name);
  const full = [first, last].filter(Boolean).join(' ');
  if (full) return full;
  return (
    str(m.phone_number) || str(m.phone) || str(data.phone_number) || 'Unknown'
  );
}

/**
 * Ported from the admin panel with the substitutions established in U4–U6a: `auth()` →
 * `getAuthenticatedUserId()`, and `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing). Query shapes and serialization are
 * the source's.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Optional ?type=outbound → surface parked outbound chats instead of the
  // default inbound oversee chats.
  const typeFilter = new URL(request.url).searchParams.get('type');

  try {
    const snap = await adminDb
      .collection('e2e_test_chats')
      .orderBy('_parked_at', 'desc')
      .get()
      .catch(async () => {
        // _parked_at may be missing on older docs — fall back to updatedAt.
        return adminDb.collection('e2e_test_chats').get();
      });

    // Default: only oversee chats are surfaced — supporting SMS/voice chats are
    // still archived (and copied) but hidden here, since the oversee chat carries
    // the full conversation. (`_oversee` is tagged at park time.)
    // With ?type=outbound: surface parked outbound chats (type === 'outbound').
    const visibleDocs = typeFilter
      ? snap.docs.filter((d) => d.data().type === typeFilter)
      : snap.docs.filter((d) => d.data()._oversee === true);

    const chats = await Promise.all(
      visibleDocs.map(async (d) => {
        const data = d.data() as any;
        const m = data.memory || {};

        // First appraisal (latest by lifecycle timestamp) drives vehicle + offer.
        let appraisal: any = null;
        try {
          const aps = await d.ref.collection('appraisals').get();
          if (aps.size > 0) {
            const at = (a: any) => a.activated_at || a.queued_at || '';
            appraisal = aps.docs
              .map((a) => a.data())
              .sort((a: any, b: any) => at(b).localeCompare(at(a)))[0];
          }
        } catch {
          /* no appraisals */
        }

        const year = str(appraisal?.year ?? m.year ?? data.year);
        const make = str(appraisal?.make ?? m.make ?? data.make);
        const model = str(appraisal?.model ?? m.model ?? data.model);
        const trim = str(appraisal?.trim ?? m.trim ?? data.trim);
        const mileage = str(appraisal?.odometer ?? m.odometer ?? data.odometer);
        const vehicle = [year, make, model].filter(Boolean).join(' ');
        const vehicleDetails = [
          trim,
          mileage && !isNaN(Number(mileage))
            ? `${Number(mileage).toLocaleString()} mi`
            : null,
        ]
          .filter(Boolean)
          .join(' · ');

        const isCertificateOffer = !!appraisal?.certificate_price;
        const offerRaw =
          appraisal?.certificate_price ??
          appraisal?.expected_price ??
          m.expected_price ??
          data.expected_price;
        const offerStr = str(String(offerRaw ?? ''));
        const offer = offerStr
          ? parseFloat(offerStr.replace(/[^0-9.]/g, ''))
          : 0;

        return {
          id: d.id,
          name: displayName(data),
          phone: str(m.phone_number || m.phone || data.phone_number),
          email: str(m.customer_email || m.email || data.customer_email),
          vehicle,
          vehicleDetails,
          stage: str(data.stage) || 'New',
          dealerName: str(data.dealer_name) || str(m.dealer_name),
          dealersId: data.dealers_id ?? null,
          offer: isNaN(offer) ? 0 : offer,
          isCertificateOffer,
          parkedAt: data._parked_at?.toDate?.()?.toISOString() ?? null,
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() ?? null,
        };
      })
    );

    // Sort newest-parked first (works whether ordered server-side or not).
    chats.sort((a, b) =>
      (b.parkedAt || b.updatedAt || '').localeCompare(
        a.parkedAt || a.updatedAt || ''
      )
    );

    return NextResponse.json({ chats }, { status: 200 });
  } catch (error: any) {
    console.error('[parked-test-chats] list error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message },
      { status: 500 }
    );
  }
}
