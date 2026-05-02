import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';
import { getAllIntelligenceForPipeline } from '../../../../lib/db/intelligence';
import { getPlaybook } from '../../../../lib/services/blobStorage';
import PlaybookViewer from './PlaybookViewer';

export default async function IntelligenceHubPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  // We are currently using a hardcoded pipelineId 'default-pipeline' as the platform
  // is conceptually acting as a single pipeline per user right now.
  const pipelineId = 'default-pipeline';

  const registries = await getAllIntelligenceForPipeline(userId, pipelineId);

  // Pre-fetch all playbooks
  const playbooks: Record<string, string> = {};
  for (const reg of registries) {
    try {
      playbooks[reg.agentRole] = await getPlaybook(reg.blobUrl);
    } catch (e) {
      playbooks[reg.agentRole] = '# Error loading playbook';
    }
  }

  const defaultRoles = [
    'strategist',
    'copywriter',
    'scraper',
    'auditor',
    'analyst',
  ];
  defaultRoles.forEach((role) => {
    if (!playbooks[role]) {
      playbooks[role] =
        `# ${role} Playbook\n\nNo feedback has been learned for this agent yet.`;
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          Intelligence Hub
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Agent Playbooks are living memory documents stored in Vercel Blob.
          When you provide feedback, the Learner Agent analyzes your outcomes
          and writes updates here, which the active Pipeline retrieves (RAG)
          during its next run.
        </p>
      </div>

      <PlaybookViewer playbooks={playbooks} />
    </div>
  );
}
