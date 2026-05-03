import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { getSettings } from '../../../../../lib/db/settings';
import {
  updateLead,
  getLeadById,
  createLead,
} from '../../../../../lib/db/leads';
import { dispatchBatch } from '../../../../../lib/services/whatsappDispatcher';
import { runBatchLearnerAgent } from '../../../../../lib/agents/learnerAgent';
import { db } from '../../../../../lib/firebase/admin';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pipelineId, sessionId, candidates } = await req.json();
    if (!pipelineId || !sessionId || !candidates) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const settings = await getSettings(userId);
    const newGlobalLeadIds: string[] = [];
    const approvedLeads = [];
    const rejectedLeads = [];
    const humanEditedMessages = [];

    // 1. Process local candidates
    for (const localLead of candidates) {
      // update sandbox lead in db
      await updateLead(userId, localLead.id, {
        whatsappNumber: localLead.whatsappNumber,
        generatedPitch: localLead.generatedPitch,
        status: localLead.triageStatus === 'rejected' ? 'Failed' : 'Qualified',
        sandboxRejected: localLead.triageStatus === 'rejected',
        sandboxRejectionReason: localLead.sandboxRejectionReason || null,
        dispatchStatus:
          localLead.triageStatus === 'approved' ? 'approved' : undefined,
      });

      const candidate = await getLeadById(userId, localLead.id);
      if (!candidate) continue;

      if (localLead.triageStatus === 'approved') {
        approvedLeads.push(candidate);
        // create global lead
        const { id, createdAt, updatedAt, isSandbox, ...pristineData } =
          candidate as any;
        const pristinePayload = {
          ...pristineData,
          dispatchStatus: 'approved',
          isSandbox: false,
        };
        const newId = await createLead(pristinePayload);
        if (!newId.startsWith('sandbox')) {
          newGlobalLeadIds.push(newId);
        }
      } else if (localLead.triageStatus === 'rejected') {
        rejectedLeads.push(candidate);
      }

      if (
        localLead.originalGeneratedPitch &&
        localLead.originalGeneratedPitch !== localLead.generatedPitch
      ) {
        humanEditedMessages.push({
          original: localLead.originalGeneratedPitch,
          edited: localLead.generatedPitch,
        });
      }
    }

    // 2. Dispatch
    if (settings.dispatchEnabled && newGlobalLeadIds.length > 0) {
      dispatchBatch(settings, newGlobalLeadIds).catch((err) => {
        console.error('Finalize dispatch batch failed:', err);
      });
    }

    // 3. Learn (Wait for it so we can stream logs to the UI)
    await runBatchLearnerAgent(
      userId,
      pipelineId,
      approvedLeads,
      rejectedLeads,
      humanEditedMessages,
      sessionId
    ).catch((err) => {
      console.error('runBatchLearnerAgent failed:', err);
    });

    // 4. Update session status
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
    await sessionRef.update({
      sessionStatus: 'Completed',
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Finalize sandbox failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
