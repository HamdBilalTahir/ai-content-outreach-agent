import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { db } from '../../../../../lib/firebase/admin';
import { runLearnerAgent } from '../../../../../lib/agents/learnerAgent';
import * as admin from 'firebase-admin';
import { updateLead } from '../../../../../lib/db/leads';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const {
      leadId,
      sessionId,
      triageStatus,
      sandboxRejectionReason,
      brandName,
    } = await req.json();

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    // Backend console log
    console.log(
      `[Triage] Lead ${leadId} (${brandName || 'Unknown Brand'}) was marked as ${triageStatus}${triageStatus === 'rejected' ? ` for reason: ${sandboxRejectionReason || 'No reason provided'}` : ''}`
    );

    let sessionRef: any;
    if (sessionId.startsWith('sandbox:')) {
      const [, pId, rId] = sessionId.split(':');
      sessionRef = db
        .collection('pipelines')
        .doc(pId)
        .collection('sandbox_runs')
        .doc(rId);
    } else {
      sessionRef = db.collection('crawlSessions').doc(sessionId);
    }

    const newLog = {
      agentRole: 'system',
      narrative: `User ${triageStatus} lead ${brandName || leadId}${triageStatus === 'rejected' ? ` - Reason: ${sandboxRejectionReason || 'None'}` : ''}`,
      timestamp: new Date().toISOString(),
    };

    await sessionRef.update({
      agentLogs: admin.firestore.FieldValue.arrayUnion(newLog),
    });

    try {
      const updatePayload: any = {
        sandboxRejectionReason: sandboxRejectionReason || null,
        status: triageStatus === 'rejected' ? 'Failed' : 'Qualified',
        sandboxRejected: triageStatus === 'rejected',
      };
      if (triageStatus === 'approved') {
        updatePayload.dispatchStatus = 'approved';
      }
      await updateLead(userId, leadId, updatePayload);
    } catch (e) {
      console.error('Failed to update lead document with triage status', e);
    }

    if (triageStatus === 'rejected' && sessionId.startsWith('sandbox:')) {
      const [, pipelineId] = sessionId.split(':');
      const signal = {
        outcome: 'Rejected' as const,
        pitchAngleUsed: 'noVideo' as const,
        gapScoreAtPitch: 0,
        notes: sandboxRejectionReason || null,
      };
      runLearnerAgent(userId, pipelineId, signal, sessionId).catch((err) =>
        console.error('[Triage] LearnerAgent failed silently:', err)
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Triage logging failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
