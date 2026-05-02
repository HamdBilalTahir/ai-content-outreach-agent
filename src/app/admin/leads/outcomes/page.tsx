import { getLeadsByStatus } from '../../../../../lib/db/leads';
import { getAllFeedbackSignals } from '../../../../../lib/db/feedbackSignals';
import OutcomeCard from './OutcomeCard';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function OutcomesPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const [pitchedLeads, signals] = await Promise.all([
    getLeadsByStatus(userId, 'Pitched', 500),
    getAllFeedbackSignals(userId),
  ]);

  const signalLeadIds = new Set(signals.map((s) => s.leadId));
  const queue = pitchedLeads.filter((lead) => !signalLeadIds.has(lead.id));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Outcome Logger</h1>
        <p className="mt-2 text-sm text-gray-600">
          Work through your pitched leads and log the final outcome. This data
          feeds directly into the AI to optimize future prospecting.
        </p>
      </div>

      <div className="flex items-center space-x-2 text-sm font-medium text-gray-500">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-blue-700">
          {queue.length}
        </span>
        <span>leads waiting for outcomes</span>
      </div>

      <div className="space-y-6">
        {queue.map((lead) => (
          <OutcomeCard key={lead.id} lead={lead} />
        ))}
        {queue.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
            <h3 className="mt-2 text-sm font-semibold text-gray-900">
              All caught up!
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              No pending pitched leads need outcome logging.
            </p>
          </div>
        )}
      </div>

      <div className="pt-10">
        <h2 className="text-xl font-semibold text-gray-900 mb-6">
          Feedback Audit Ledger
        </h2>
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
          <ul className="divide-y divide-gray-200">
            {signals.map((signal) => (
              <li key={signal.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start space-x-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">
                      Human Input:{' '}
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                          signal.outcome === 'Closed'
                            ? 'bg-green-50 text-green-700 ring-green-600/20'
                            : signal.outcome === 'Rejected'
                              ? 'bg-red-50 text-red-700 ring-red-600/20'
                              : 'bg-gray-50 text-gray-600 ring-gray-500/10'
                        }`}
                      >
                        {signal.outcome}
                      </span>
                    </p>
                    {signal.notes && (
                      <p className="mt-1 text-sm text-gray-500 italic">
                        "{signal.notes}"
                      </p>
                    )}
                    {signal.aiAdjustmentLog && (
                      <div className="mt-3 bg-blue-50/50 rounded-md p-3 border border-blue-100">
                        <p className="text-sm text-blue-800">
                          <strong>AI Adjustment:</strong>{' '}
                          {signal.aiAdjustmentLog}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-sm text-gray-500">
                    {signal.recordedAt?.toDate().toLocaleString()}
                  </div>
                </div>
              </li>
            ))}
            {signals.length === 0 && (
              <li className="p-4 text-center text-sm text-gray-500">
                No feedback history available.
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
