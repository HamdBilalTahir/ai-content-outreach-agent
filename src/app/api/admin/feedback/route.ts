import { NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getLeadById } from '../../../../../lib/db/leads';
import { getNicheById } from '../../../../../lib/db/niches';
import { createFeedbackSignal } from '../../../../../lib/db/feedbackSignals';
import { db } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { leadId, outcome, notes } = body;

    if (!leadId || !outcome) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const lead = await getLeadById(userId, leadId);
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    const niche = await getNicheById(userId, lead.nicheId);
    if (!niche) {
      return NextResponse.json({ error: 'Niche not found' }, { status: 404 });
    }

    const signalId = await createFeedbackSignal({
      userId,
      leadId,
      nicheId: lead.nicheId,
      outcome,
      pitchAngleUsed: lead.pitchAngle || 'noVideo', // default if missing
      productPrice: niche.avgProductPrice,
      gapScoreAtPitch: lead.socialMediaGapScore ?? 0,
      notes: notes || null,
      recordedAt: FieldValue.serverTimestamp() as Timestamp,
    });

    // Mark lead as no longer just 'Pitched' so it disappears from the queue.
    // Wait, the requirements don't explicitly say to change the lead status,
    // they say "After logging, the card disappears from the queue".
    // The queue shows leads with status 'Pitched' that do not yet have a FeedbackSignal.
    // If we just create the FeedbackSignal, it will be excluded.

    return NextResponse.json({ success: true, signalId });
  } catch (error: any) {
    console.error('Error logging feedback:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
