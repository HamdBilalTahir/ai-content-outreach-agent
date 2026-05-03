import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { getLeadById } from '../../../../../lib/db/leads';
import { getPitchEvaluationByLeadId } from '../../../../../lib/db/pitchEvaluations';
import { getDispatchLogsByLeadId } from '../../../../../lib/db/dispatchLogs';
import { getAllNiches } from '../../../../../lib/db/niches';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const { id } = await params;

  const [lead, pitchEval, dispatchLogs, niches] = await Promise.all([
    getLeadById(userId, id),
    getPitchEvaluationByLeadId(id), // Note: leadId is universally unique
    getDispatchLogsByLeadId(id), // Note: leadId is universally unique
    getAllNiches(userId),
  ]);

  if (!lead) {
    notFound();
  }

  const nicheName =
    niches.find((n) => n.id === lead.nicheId)?.nicheName || lead.nicheId;

  return (
    <div className="space-y-8">
      <div className="flex items-center space-x-4">
        <Link href="/admin/leads" className="text-gray-500 hover:text-gray-900">
          &larr; Back to Leads
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">
          Lead Details: {lead.brandName}
        </h1>
        <span
          className={`inline-block rounded-full px-3 py-1 text-sm font-medium ${
            lead.status === 'Qualified'
              ? 'bg-green-100 text-green-700'
              : lead.status === 'Pitched'
                ? 'bg-purple-100 text-purple-700'
                : 'bg-red-100 text-red-700'
          }`}
        >
          {lead.status}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Core Lead Info */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-medium text-gray-900">
            Brand Information
          </h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-gray-500">Niche</dt>
              <dd className="mt-1 text-sm text-gray-900">{nicheName}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Website</dt>
              <dd className="mt-1 text-sm text-blue-600">
                <a
                  href={lead.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {lead.websiteUrl}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Instagram</dt>
              <dd className="mt-1 text-sm text-blue-600">
                {lead.instagramUrl ? (
                  <a
                    href={lead.instagramUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {lead.instagramUrl}
                  </a>
                ) : (
                  <span className="text-gray-400">None found</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">WhatsApp</dt>
              <dd className="mt-1 text-sm font-mono text-gray-900">
                {lead.whatsappNumber}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">
                Target Product
              </dt>
              <dd className="mt-1 text-sm text-gray-900">
                {lead.targetProductName || '-'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Created At</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {lead.createdAt?.toDate().toLocaleString() || 'Unknown'}
              </dd>
            </div>
          </dl>
          {lead.targetProductImageUrl && (
            <div className="mt-4">
              <span className="text-sm font-medium text-gray-500">
                Product Image
              </span>
              <div className="mt-2 relative h-32 w-32 rounded-md overflow-hidden border border-gray-200">
                <Image
                  src={lead.targetProductImageUrl}
                  alt={lead.targetProductName || 'Product'}
                  fill
                  className="object-cover"
                  unoptimized
                />
              </div>
            </div>
          )}
        </section>

        {/* Pitch Generation Data */}
        <section className="rounded-lg border border-gray-200 bg-white p-6 flex flex-col">
          <h2 className="mb-4 text-lg font-medium text-gray-900">
            Generated Pitch
          </h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Angle</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {lead.pitchAngle || '-'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Gap Score</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {lead.socialMediaGapScore ?? '-'}
              </dd>
            </div>
          </div>
          <div className="flex-1 rounded-md bg-gray-50 p-4 border border-gray-200 overflow-y-auto max-h-64">
            <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans">
              {lead.generatedPitch || 'No pitch generated.'}
            </pre>
          </div>
        </section>

        {/* Pitch Evaluation Details */}
        <section className="rounded-lg border border-gray-200 bg-white p-6 lg:col-span-2">
          <h2 className="mb-4 text-lg font-medium text-gray-900">
            AI Evaluation Details
          </h2>
          {pitchEval ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-md bg-gray-50 p-3 border border-gray-200">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Website Summary
                  </h3>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">
                    {pitchEval.websiteTextSummary || 'N/A'}
                  </p>
                </div>
                <div className="rounded-md bg-gray-50 p-3 border border-gray-200">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Instagram Summary
                  </h3>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">
                    {pitchEval.igPostSummary || 'N/A'}
                  </p>
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Raw AI Output
                </h3>
                <details className="text-sm text-gray-600">
                  <summary className="cursor-pointer hover:text-gray-900">
                    View raw JSON
                  </summary>
                  <pre className="mt-2 p-3 bg-gray-100 rounded-md overflow-x-auto text-xs text-gray-800">
                    {pitchEval.rawGeminiResponse}
                  </pre>
                </details>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              No pitch evaluation linked to this lead.
            </p>
          )}
        </section>

        {/* Dispatch Logs */}
        <section className="rounded-lg border border-gray-200 bg-white p-6 lg:col-span-2">
          <h2 className="mb-4 text-lg font-medium text-gray-900">
            Dispatch Logs
          </h2>
          {dispatchLogs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Number</th>
                    <th className="px-4 py-3">Attempt</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {dispatchLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {log.dispatchedAt?.toDate().toLocaleString() ||
                          'Unknown'}
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-600">
                        {log.whatsappNumber}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {log.attemptNumber}
                      </td>
                      <td className="px-4 py-3">
                        {log.success ? (
                          <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                            Success
                          </span>
                        ) : (
                          <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            Failed
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 max-w-xs truncate">
                        {log.errorMessage || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No dispatch attempts yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
