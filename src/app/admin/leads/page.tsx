import Link from 'next/link';
import { getLeads, getLeadsByStatus } from '../../../../lib/db/leads';
import { getAllNiches } from '../../../../lib/db/niches';
import type { Lead } from '../../../../lib/types';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';
import LeadRow from './LeadRow';

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
        <h1 className="text-xl font-semibold text-gray-900">Leads Workspace</h1>
        <div className="flex items-center space-x-4">
          <div className="flex space-x-2 border-r border-gray-300 pr-4">
            <Link
              href="/admin/leads/outcomes"
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-indigo-600 border border-indigo-200 hover:bg-indigo-50"
            >
              Outcome Logger
            </Link>
          </div>
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
              <th className="px-4 py-3 text-left">Teach AI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leads.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                nicheName={nicheMap.get(lead.nicheId) || 'Unknown'}
              />
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
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
