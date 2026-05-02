import { getLeadsByStatus } from '../../../../lib/db/leads';
import { getAllFeedbackSignals } from '../../../../lib/db/feedbackSignals';
import OutcomeCard from './OutcomeCard';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
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
    </div>
  );
}
