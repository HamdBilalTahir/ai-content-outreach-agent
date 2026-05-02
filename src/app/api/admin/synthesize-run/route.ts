import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { runBatchLearnerAgent } from '../../../../../lib/agents/learnerAgent';
import { db } from '../../../../../lib/firebase/admin';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pipelineId, runId } = await req.json();
    if (!pipelineId || !runId) {
      return NextResponse.json(
        { error: 'pipelineId and runId are required' },
        { status: 400 }
      );
    }

    // Query sandbox candidates for this run
    let rId = runId;
    if (runId.startsWith('sandbox:')) {
      rId = runId.split(':')[2];
    }
    const snapshot = await db
      .collection('pipelines')
      .doc(pipelineId)
      .collection('sandbox_runs')
      .doc(rId)
      .collection('sandbox_candidates')
      .where('userId', '==', userId)
      .get();

    const leads = snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as any
    );

    const approvedLeads = leads.filter(
      (l: any) => l.dispatchStatus === 'approved'
    );
    const rejectedLeads = leads.filter(
      (l: any) => l.status === 'Failed' && l.sandboxRejected === true
    );

    const humanEditedMessages = leads
      .filter(
        (l: any) =>
          l.originalGeneratedPitch &&
          l.originalGeneratedPitch !== l.generatedPitch
      )
      .map((l: any) => ({
        original: l.originalGeneratedPitch,
        edited: l.generatedPitch,
      }));

    // Run batch learner agent in the background or wait. We will wait for simplicity, or background it.
    // The requirement says "UI shows a loading state... completion... successfully updated." so we wait.
    await runBatchLearnerAgent(
      userId,
      pipelineId,
      approvedLeads,
      rejectedLeads,
      humanEditedMessages
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Synthesize run failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
