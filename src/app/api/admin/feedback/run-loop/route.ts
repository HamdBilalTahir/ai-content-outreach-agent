import { NextResponse } from 'next/server';
import { runFeedbackLoop } from '../../../../../../lib/agents/feedbackLoopAgent';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

export async function POST() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await runFeedbackLoop(userId);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('runFeedbackLoop failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
