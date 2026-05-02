import { NextResponse } from 'next/server';
import {
  createPipeline,
  updatePipeline,
} from '../../../../../lib/db/pipelines';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { name, description } = await req.json();
    if (!name) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    const id = await createPipeline({
      userId,
      name,
      description: description || '',
      status: 'stopped',
      connectionId: null,
      settings: {
        overrideGlobalDeduplication: false,
      },
    });

    return NextResponse.json({ success: true, id });
  } catch (error: any) {
    console.error('Create pipeline failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id, status, connectionId, settings } = await req.json();

    if (!id) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    await updatePipeline(userId, id, {
      status,
      connectionId,
      settings,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Update pipeline failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
