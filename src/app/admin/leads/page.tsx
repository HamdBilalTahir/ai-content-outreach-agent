import Link from 'next/link';
import { getLeads, getLeadsByStatus } from '../../../../lib/db/leads';
import { getAllNiches } from '../../../../lib/db/niches';
import type { Lead } from '../../../../lib/types';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const { status } = await searchParams;

  const [leads, niches] = await Promise.all([
    status && status !== 'All'
      ? getLeadsByStatus(userId, status as Lead['status'], 200)
      : getLeads(userId, 200),
    getAllNiches(userId),
  ]);

  const nicheMap = new Map(niches.map((n) => [n.id, n.nicheName]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Leads</h1>
        <div className="flex space-x-2">
          <Link
            href="/admin/leads?status=All"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              !status || status === 'All'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            All
          </Link>
          <Link
            href="/admin/leads?status=Qualified"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              status === 'Qualified'
                ? 'bg-green-100 text-green-700'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            Qualified
          </Link>
          <Link
            href="/admin/leads?status=Pitched"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              status === 'Pitched'
                ? 'bg-purple-100 text-purple-700'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            Pitched
          </Link>
          <Link
            href="/admin/leads?status=Failed"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              status === 'Failed'
                ? 'bg-red-100 text-red-700'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            Failed
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Brand</th>
              <th className="px-4 py-3 text-left">Niche</th>
              <th className="px-4 py-3 text-right">Gap Score</th>
              <th className="px-4 py-3 text-left">Pitch Angle</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Created Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leads.map((lead) => (
              <tr key={lead.id} className="hover:bg-gray-50 cursor-pointer">
                <td className="px-4 py-3 font-medium text-blue-600">
                  <Link
                    href={`/admin/leads/${lead.id}`}
                    className="hover:underline"
                  >
                    {lead.brandName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {nicheMap.get(lead.nicheId) || 'Unknown'}
                </td>
                <td className="px-4 py-3 text-right text-gray-600">
                  {lead.socialMediaGapScore ?? '-'}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {lead.pitchAngle ? (
                    <span className="inline-block rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">
                      {lead.pitchAngle}
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      lead.status === 'Qualified'
                        ? 'bg-green-100 text-green-700'
                        : lead.status === 'Pitched'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {lead.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {lead.createdAt?.toDate().toLocaleString() || 'Unknown'}
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  No leads found for this status.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
