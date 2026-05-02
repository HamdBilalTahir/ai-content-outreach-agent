import { NextResponse } from 'next/server';
import { createNiche, updateNiche } from '../../../../../lib/db/niches';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { nicheName, seedUrls, crawlPriority } = await req.json();

    if (
      !nicheName ||
      !Array.isArray(seedUrls) ||
      typeof crawlPriority !== 'number'
    ) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    const id = await createNiche({
      userId,
      nicheName,
      seedUrls,
      crawlPriority,
      avgGapScore: 0,
      closeRate: 0,
      avgProductPrice: 0,
      blacklistedSignals: [],
      lastCrawled: null as any, // or some default, wait, lastCrawled is Timestamp
    });

    return NextResponse.json({ success: true, id });
  } catch (error: any) {
    console.error('Create niche failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id, seedUrls, crawlPriority } = await req.json();

    if (!id || !Array.isArray(seedUrls) || typeof crawlPriority !== 'number') {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    await updateNiche(userId, id, {
      seedUrls,
      crawlPriority,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Update niche failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
