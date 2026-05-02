import { NextResponse } from 'next/server';
import { updateSettings } from '../../../../../lib/db/settings';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

export async function PATCH(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const data = await req.json();
    await updateSettings(userId, data);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Update settings failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
