import { NextRequest, NextResponse } from 'next/server';
import { dispatchBatch } from '../../../../../lib/services/whatsappDispatcher';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { getAllSettings } = await import('../../../../../lib/db/settings');
    const allSettings = await getAllSettings();
    const currentHour = new Date().getUTCHours();

    let dispatchedCount = 0;

    const { db } = await import('../../../../../lib/firebase/admin');
    const runningPipelinesSnapshot = await db
      .collection('pipelines')
      .where('status', '==', 'running')
      .get();

    // Group running pipelines by user
    const runningPipelinesByUserId: Record<string, string[]> = {};
    runningPipelinesSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!runningPipelinesByUserId[data.userId]) {
        runningPipelinesByUserId[data.userId] = [];
      }
      runningPipelinesByUserId[data.userId].push(doc.id);
    });

    for (const settings of allSettings) {
      if (
        !settings.dispatchEnabled ||
        currentHour !== settings.dispatchScheduleHour
      ) {
        continue;
      }

      const activePipelineIds = runningPipelinesByUserId[settings.userId] || [];
      if (activePipelineIds.length === 0) continue;

      await dispatchBatch(settings, undefined, activePipelineIds);
      dispatchedCount++;
    }

    return NextResponse.json({
      success: true,
      dispatchedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Cron dispatch failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
