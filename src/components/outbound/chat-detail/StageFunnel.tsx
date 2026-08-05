import { cn } from '@/lib/utils';
import { STAGE_ORDER, stageColor } from './helpers';

// Compact stage funnel for the sidebar (wraps in the narrow column).
export function StageFunnel({ currentStage }: { currentStage: string | null }) {
  if (currentStage === 'Lost')
    return (
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-[11px] font-medium',
          stageColor('Lost')
        )}
      >
        Lost
      </span>
    );
  const currentIdx = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER.map((stage, i) => {
        const reached = currentIdx >= i;
        return (
          <span key={stage} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-[11px] text-gray-300">→</span>}
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                reached
                  ? stageColor(stage)
                  : 'border-gray-200 bg-white text-gray-400'
              )}
            >
              {stage}
            </span>
          </span>
        );
      })}
    </div>
  );
}
