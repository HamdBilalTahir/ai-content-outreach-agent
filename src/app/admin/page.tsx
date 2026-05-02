import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../../../lib/firebase/admin';
import { getAllNiches } from '../../../lib/db/niches';
import { getRecentCrawlSessions } from '../../../lib/db/crawlSessions';
import { getAuthenticatedUserId } from '../../../lib/utils/auth';
import { redirect } from 'next/navigation';

async function fetchStatusCounts(
  userId: string
): Promise<Record<string, number>> {
  const snapshot = await db
    .collection('leads')
    .where('userId', '==', userId)
    .get();
  const counts: Record<string, number> = {
    Qualified: 0,
    Pitched: 0,
    Failed: 0,
  };
  for (const doc of snapshot.docs) {
    const status = doc.data().status as string;
    if (status in counts) counts[status]++;
  }
  return counts;
}

async function fetchTodayStats(userId: string): Promise<{
  createdToday: number;
  qualifiedToday: number;
  dispatchedToday: number;
}> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startTs = Timestamp.fromDate(todayStart);

  const [leadsSnap, dispatchSnap] = await Promise.all([
    db
      .collection('leads')
      .where('userId', '==', userId)
      .where('createdAt', '>=', startTs)
      .get(),
    db
      .collection('dispatchLogs')
      .where('userId', '==', userId)
      .where('dispatchedAt', '>=', startTs)
      .get(),
  ]);

  const qualifiedToday = leadsSnap.docs.filter(
    (d) => d.data().status === 'Qualified'
  ).length;

  return {
    createdToday: leadsSnap.size,
    qualifiedToday,
    dispatchedToday: dispatchSnap.size,
  };
}

async function fetchNicheLeadCounts(
  userId: string
): Promise<Map<string, number>> {
  const snapshot = await db
    .collection('leads')
    .where('userId', '==', userId)
    .select('nicheId')
    .get();
  const counts = new Map<string, number>();
  for (const doc of snapshot.docs) {
    const id = doc.data().nicheId as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

export default async function AdminDashboard() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const [statusCounts, todayStats, niches, sessions, nicheLeadCounts] =
    await Promise.all([
      fetchStatusCounts(userId),
      fetchTodayStats(userId),
      getAllNiches(userId),
      getRecentCrawlSessions(userId, 5),
      fetchNicheLeadCounts(userId),
    ]);

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>

      {/* Metric cards */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">
          Pipeline Overview
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Qualified" value={statusCounts.Qualified} />
          <StatCard label="Pitched" value={statusCounts.Pitched} />
          <StatCard label="Failed" value={statusCounts.Failed} />
          <StatCard label="Created today" value={todayStats.createdToday} />
          <StatCard
            label="Dispatched today"
            value={todayStats.dispatchedToday}
          />
          <StatCard label="Qualified today" value={todayStats.qualifiedToday} />
        </div>
      </section>

      {/* Niche performance table */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">
          Niche Performance
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Niche</th>
                <th className="px-4 py-3 text-right">Priority</th>
                <th className="px-4 py-3 text-right">Avg Gap Score</th>
                <th className="px-4 py-3 text-right">Close Rate</th>
                <th className="px-4 py-3 text-right">Total Leads</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {niches.map((niche) => (
                <tr key={niche.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {niche.nicheName}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {niche.crawlPriority}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {niche.avgGapScore.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {(niche.closeRate * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {nicheLeadCounts.get(niche.id) ?? 0}
                  </td>
                </tr>
              ))}
              {niches.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-gray-400"
                  >
                    No niches found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent crawl sessions */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">
          Recent Crawl Sessions
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Niche</th>
                <th className="px-4 py-3 text-right">Discovered</th>
                <th className="px-4 py-3 text-right">Qualified</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sessions.map((session) => {
                const nicheName =
                  niches.find((n) => n.id === session.nicheId)?.nicheName ||
                  session.nicheId;
                return (
                  <tr key={session.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {nicheName}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {session.discoveredBrands?.length || 0}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {session.leadsQualified}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          session.sessionStatus === 'Completed'
                            ? 'bg-green-100 text-green-700'
                            : session.sessionStatus === 'Running'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {session.sessionStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {session.startedAt?.toDate().toLocaleString() ||
                        'Unknown'}
                    </td>
                  </tr>
                );
              })}
              {sessions.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-gray-400"
                  >
                    No sessions found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
