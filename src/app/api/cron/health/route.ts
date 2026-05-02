import { NextResponse } from 'next/server';
import { db } from '../../../../../lib/firebase/admin';
import type { Connection } from '../../../../../lib/types';
import { getConnectedAccounts } from '../../../../../lib/services/unipile';

export async function GET(req: Request) {
  try {
    // Ideally use a secret auth header for cron
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      // In development, maybe ignore, but good practice
      if (process.env.NODE_ENV === 'production') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const snapshot = await db
      .collection('connections')
      .where('status', '==', 'connected')
      .get();

    // Group connections by userId to fetch Unipile accounts
    const userIds = new Set<string>();
    snapshot.docs.forEach((doc: any) => userIds.add(doc.data().userId));

    let updatedCount = 0;

    for (const userId of userIds) {
      let activeAccounts: any[] = [];
      try {
        activeAccounts = await getConnectedAccounts(userId);
      } catch (err) {
        console.error(`Failed to fetch Unipile accounts for ${userId}`, err);
        continue;
      }

      const activeAccountIds = new Set(
        activeAccounts.map((a: any) => a.accountId)
      );

      const userDocs = snapshot.docs.filter(
        (doc: any) => doc.data().userId === userId
      );
      for (const doc of userDocs) {
        const conn = doc.data() as Connection;
        if (conn.instanceId && !activeAccountIds.has(conn.instanceId)) {
          // Connection is disconnected
          await doc.ref.update({
            status: 'disconnected',
            updatedAt: new Date(),
          });
          updatedCount++;
        }
      }
    }

    return NextResponse.json({ success: true, updatedCount });
  } catch (err: any) {
    console.error('Health check failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
