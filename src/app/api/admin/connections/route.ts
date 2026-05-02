import { NextResponse } from 'next/server';
import {
  createOrUpdateConnection,
  disconnectPrimaryConnection,
} from '../../../../../lib/db/connections';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { countryCode, phoneNumber } = await req.json();

    if (!countryCode || !phoneNumber) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    await createOrUpdateConnection(userId, {
      provider: 'whatsapp',
      countryCode,
      phoneNumber,
      status: 'connected',
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Create connection failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await disconnectPrimaryConnection(userId);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Disconnect failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
