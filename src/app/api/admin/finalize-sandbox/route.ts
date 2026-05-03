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
      // determine correct final status
      let finalStatus =
        localLead.triageStatus === 'rejected' ? 'Failed' : 'Qualified';
      if (!localLead.whatsappNumber && finalStatus !== 'Failed') {
        finalStatus = 'incomplete';
      }

      // update sandbox lead in db
      const updatePayload: any = {
        whatsappNumber: localLead.whatsappNumber,
        generatedPitch: localLead.generatedPitch,
        status: finalStatus,
        sandboxRejected: localLead.triageStatus === 'rejected',
        sandboxRejectionReason: localLead.sandboxRejectionReason || null,
      };
      if (localLead.triageStatus === 'approved') {
        updatePayload.dispatchStatus = 'approved';
      } else if (localLead.dispatchStatus) {
        // If it had a dispatchStatus and we are not approving it, we can nullify it or leave it alone
        // But to avoid undefined error:
        updatePayload.dispatchStatus = null;
      }

      await updateLead(userId, localLead.id, updatePayload);

      const candidate = await getLeadById(userId, localLead.id);
      if (!candidate) continue;

      if (localLead.triageStatus === 'approved') {
        approvedLeads.push(candidate);
        // create global lead

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      sessionStatus: 'Ended',
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
