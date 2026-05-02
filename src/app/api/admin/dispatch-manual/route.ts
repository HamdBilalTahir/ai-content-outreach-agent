import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { getSettings } from '../../../../../lib/db/settings';
import { updateLead } from '../../../../../lib/db/leads';
import { dispatchBatch } from '../../../../../lib/services/whatsappDispatcher';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { leadIds } = await req.json();
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return NextResponse.json(
        { error: 'No lead IDs provided' },
        { status: 400 }
      );
    }

    const settings = await getSettings(userId);
    if (!settings.dispatchEnabled) {
      return NextResponse.json(
        { error: 'Dispatch is disabled in settings' },
        { status: 400 }
      );
    }

    const { getLeadById, createLead } =
      await import('../../../../../lib/db/leads');

    const newGlobalLeadIds: string[] = [];

    // First update the status for all selected leads in sandbox to approved
    // And migrate them to the global leads collection
    for (const leadId of leadIds) {
      // 1. Update the sandbox candidate so Synthesizer knows it was approved
      await updateLead(userId, leadId, {
        dispatchStatus: 'approved',
      });

      // 2. Read the sandbox candidate data
      const candidate = await getLeadById(userId, leadId);
      if (!candidate) continue;

      // 3. Create pristine global lead
      const { id, createdAt, updatedAt, isSandbox, ...pristineData } =
        candidate as any;
      const pristinePayload = {
        ...pristineData,
        dispatchStatus: 'approved',
        isSandbox: false,
      };

      const newId = await createLead(pristinePayload);
      if (!newId.startsWith('sandbox')) {
        newGlobalLeadIds.push(newId);
      } else {
        // Fallback if something weird happened (shouldn't because isSandbox=false)
        newGlobalLeadIds.push(newId);
      }
    }

    // Run the dispatch in background with the new global lead IDs
    dispatchBatch(settings, newGlobalLeadIds).catch((err: unknown) => {
      console.error('Manual dispatch batch failed:', err);
    });

    return NextResponse.json({
      success: true,
      message: `Started dispatching ${newGlobalLeadIds.length} lead(s).`,
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
