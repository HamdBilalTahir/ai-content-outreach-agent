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

    const { pipelineId, runId, candidates } = await req.json();
    if (!pipelineId || !runId) {
      return NextResponse.json(
        { error: 'pipelineId and runId are required' },
        { status: 400 }
      );
    }

    // Derive the run doc ID (strip the sandbox: prefix if present)
    const rId = runId.startsWith('sandbox:') ? runId.split(':')[2] : runId;
    const containerId = `sandbox_${pipelineId}_${rId}`;

    const snapshot = await db
      .collection('leads')
      .doc(containerId)
      .collection('items')
      .where('userId', '==', userId)
      .get();

    let leads = snapshot.docs.map((doc) => ({
      id: `sandbox:${pipelineId}:${rId}:${doc.id}`,
      ...doc.data(),
    })) as any[];

    // Merge in front-end overrides if provided
    if (candidates && candidates.length > 0) {
      const overridesMap = new Map(candidates.map((c: any) => [c.id, c]));
      leads = leads.map((l) => {
        if (overridesMap.has(l.id)) {
          return { ...l, ...(overridesMap.get(l.id) as any) };
        }
        return l;
      });
    }

    const approvedLeads = leads.filter(
      (l: any) =>
        l.dispatchStatus === 'approved' || l.triageStatus === 'approved'
    );
    const rejectedLeads = leads.filter(
      (l: any) =>
        (l.status === 'Failed' && l.sandboxRejected === true) ||
        l.triageStatus === 'rejected'
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

    await runBatchLearnerAgent(
      userId,
      pipelineId,
      approvedLeads,
      rejectedLeads,
      humanEditedMessages,
      runId
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
