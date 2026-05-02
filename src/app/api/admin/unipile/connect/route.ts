import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';
import { createUnipileHostedAuthLink } from '../../../../../../lib/services/unipile';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { successUrl } = await req.json();
    if (!successUrl) {
      return NextResponse.json(
        { error: 'successUrl is required' },
        { status: 400 }
      );
    }

    const url = await createUnipileHostedAuthLink(userId, successUrl);

    return NextResponse.json({ url });
  } catch (error: any) {
    console.error('Failed to create Unipile connect link:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
