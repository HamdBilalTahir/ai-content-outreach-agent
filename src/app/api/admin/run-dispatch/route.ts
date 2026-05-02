import { NextResponse } from 'next/server';
import { dispatchBatch } from '../../../../../lib/services/whatsappDispatcher';
import { getSettings } from '../../../../../lib/db/settings';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

export async function POST() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await getSettings(userId);
    if (!settings.dispatchEnabled) {
      return NextResponse.json(
        { message: 'Dispatching is disabled in settings' },
        { status: 200 }
      );
    }

    await dispatchBatch(settings);
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Manual dispatch failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
