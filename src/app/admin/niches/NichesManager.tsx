'use client';

import React, { useState, useMemo } from 'react';
import type { Niche, Pipeline } from '../../../../lib/types';
import { useRouter } from 'next/navigation';

function HealthBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const color =
    pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-500">{pct}/100</span>
    </div>
  );
}

export default function NichesManager({
  initialNiches,
  pipelines,
}: {
  initialNiches: Niche[];
  pipelines: Pipeline[];
}) {
  const router = useRouter();
  const [niches, setNiches] = useState<Niche[]>(initialNiches);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('all');
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form states
  const [nicheName, setNicheName] = useState('');
  const [seedUrls, setSeedUrls] = useState('');
  const [crawlPriority, setCrawlPriority] = useState(5);
  const [maxDailyCrawls, setMaxDailyCrawls] = useState(10);
  const [maxDailyDispatches, setMaxDailyDispatches] = useState(5);
  const [minAiGapScore, setMinAiGapScore] = useState(6.0);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRunningLoop, setIsRunningLoop] = useState(false);

  const filteredNiches = useMemo(() => {
    if (selectedPipelineId === 'all') return niches;
    return niches.filter((n) => n.pipelineId === selectedPipelineId);
  }, [niches, selectedPipelineId]);

  const pipelineMap = useMemo(
    () => new Map(pipelines.map((p) => [p.id, p.name])),
    [pipelines]
  );

  const startCreate = () => {
    setIsCreating(true);
    setEditingId(null);
    setNicheName('');
    setSeedUrls('');
    setCrawlPriority(5);
    setMaxDailyCrawls(10);
    setMaxDailyDispatches(5);
    setMinAiGapScore(6.0);
  };

  const startEdit = (niche: Niche) => {
    setIsCreating(false);
    setEditingId(niche.id);
    setNicheName(niche.nicheName);
    setSeedUrls((niche.seedUrls || []).join('\n'));
    setCrawlPriority(niche.crawlPriority);
    setMaxDailyCrawls(niche.pipelineGuardrails?.maxDailyCrawls || 10);
    setMaxDailyDispatches(niche.pipelineGuardrails?.maxDailyDispatches || 5);
    setMinAiGapScore(niche.pipelineGuardrails?.minAiGapScore || 6.0);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    setIsSubmitting(true);
    const urls = seedUrls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);

    try {
      const pipelineGuardrails = {
        maxDailyCrawls,
        maxDailyDispatches,
        minAiGapScore,
      };

      if (isCreating) {
        await fetch('/api/admin/niches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nicheName,
            seedUrls: urls,
            crawlPriority,
            pipelineGuardrails,
          }),
        });
      } else if (editingId) {
        await fetch('/api/admin/niches', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingId,
            seedUrls: urls,
            crawlPriority,
            pipelineGuardrails,
          }),
        });
      }
      setIsCreating(false);
      setEditingId(null);
      router.refresh();
    } catch (err) {
      console.error(err);
      alert('Failed to save niche');
    } finally {
      setIsSubmitting(false);
    }
  };

  const runFeedbackLoop = async () => {
    setIsRunningLoop(true);
    try {
      const res = await fetch('/api/admin/feedback/run-loop', {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to run feedback loop');
      alert('Feedback loop ran successfully!');
      router.refresh();
    } catch (err) {
      console.error(err);
      alert('Error running feedback loop');
    } finally {
      setIsRunningLoop(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            Niche Intelligence
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            AI-managed market targets. Cooled-down niches are automatically
            replaced.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Pipeline filter */}
          <select
            value={selectedPipelineId}
            onChange={(e) => setSelectedPipelineId(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-blue-500"
          >
            <option value="all">All Pipelines</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={runFeedbackLoop}
            disabled={isRunningLoop}
            className="rounded-md bg-purple-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-500 disabled:opacity-50"
          >
            {isRunningLoop ? 'Running...' : 'Run Feedback Loop'}
          </button>
          <button
            onClick={startCreate}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
          >
            New Niche
          </button>
        </div>
      </div>

      {/* Create / Edit form */}
      {(isCreating || editingId) && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm mb-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">
            {isCreating ? 'Create New Niche' : `Edit Niche: ${nicheName}`}
          </h2>
          <div className="space-y-4">
            {isCreating && (
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Niche Name
                </label>
                <input
                  type="text"
                  value={nicheName}
                  onChange={(e) => setNicheName(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                  placeholder="e.g. Roofers in Texas"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Seed URLs (one per line)
              </label>
              <textarea
                value={seedUrls}
                onChange={(e) => setSeedUrls(e.target.value)}
                rows={4}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                placeholder="https://example1.com&#10;https://example2.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Crawl Priority (1-10)
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={crawlPriority}
                onChange={(e) =>
                  setCrawlPriority(parseInt(e.target.value) || 1)
                }
                className="mt-1 block w-full sm:w-32 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
              />
            </div>
            <div className="border-t border-gray-200 pt-4 mt-4">
              <h3 className="text-sm font-medium text-gray-900 mb-4">
                Pipeline Guardrails
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Max Daily Crawls
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={maxDailyCrawls}
                    onChange={(e) =>
                      setMaxDailyCrawls(parseInt(e.target.value) || 0)
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Max Daily Dispatches
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={maxDailyDispatches}
                    onChange={(e) =>
                      setMaxDailyDispatches(parseInt(e.target.value) || 0)
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Min AI Gap Score
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={minAiGapScore}
                    onChange={(e) =>
                      setMinAiGapScore(parseFloat(e.target.value) || 0)
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200 mt-4">
              <button
                type="button"
                onClick={cancelForm}
                className="text-sm font-semibold text-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSubmitting}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Niches table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Niche</th>
              <th className="px-4 py-3 text-left">Pipeline</th>
              <th className="px-4 py-3 text-right">Priority</th>
              <th className="px-4 py-3 text-right">Avg Gap</th>
              <th className="px-4 py-3 text-right">Close Rate</th>
              <th className="px-4 py-3 text-left">Health</th>
              <th className="px-4 py-3 text-left">Last Crawled</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredNiches.map((niche) => {
              const isCoolDown = (niche.status ?? 'active') === 'cool-down';
              const isAutoAdded = !!niche.replacedNicheId;
              const healthScore = niche.health_score ?? 100;
              const lastCrawledMs = niche.lastCrawled as any;
              const lastCrawledDate = lastCrawledMs
                ? new Date(
                    typeof lastCrawledMs === 'object' &&
                      'toMillis' in lastCrawledMs
                      ? lastCrawledMs.toMillis()
                      : lastCrawledMs
                  )
                : null;

              return (
                <React.Fragment key={niche.id}>
                  <tr
                    className={
                      isCoolDown ? 'bg-red-50 opacity-75' : 'hover:bg-gray-50'
                    }
                  >
                    {/* Name + badges */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`font-medium ${isCoolDown ? 'text-red-700 line-through' : 'text-gray-900'}`}
                        >
                          {niche.nicheName}
                        </span>
                        {isCoolDown && (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            Cool-Down
                          </span>
                        )}
                        {isAutoAdded && !isCoolDown && (
                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                            Auto-Added
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Pipeline */}
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {pipelineMap.get(niche.pipelineId) ?? niche.pipelineId}
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
                    {/* Health bar */}
                    <td className="px-4 py-3">
                      <HealthBar score={healthScore} />
                    </td>
                    {/* Last crawled */}
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {lastCrawledDate
                        ? lastCrawledDate.toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Never'}
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      {!isCoolDown && (
                        <button
                          onClick={() => startEdit(niche)}
                          className="text-blue-600 hover:text-blue-900 font-medium text-xs"
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>

                  {/* Detail row */}
                  {(niche.aiReasoning ||
                    niche.marketHypothesis ||
                    isCoolDown ||
                    isAutoAdded) && (
                    <tr className={isCoolDown ? 'bg-red-50' : 'bg-blue-50/40'}>
                      <td colSpan={8} className="px-4 py-3 text-xs space-y-1.5">
                        {/* Cool-down reason */}
                        {isCoolDown && niche.coolDownReason && (
                          <div className="text-red-700">
                            <strong>Paused:</strong> {niche.coolDownReason}
                          </div>
                        )}
                        {/* Auto-added label */}
                        {isAutoAdded && (
                          <div className="text-amber-700">
                            <strong>Autonomously added</strong> to replace{' '}
                            <span className="font-medium">
                              {niche.replacedNicheName}
                            </span>
                            . {niche.aiReasoning}
                          </div>
                        )}
                        {/* Market hypothesis */}
                        {niche.marketHypothesis && !isAutoAdded && (
                          <div className="text-blue-800">
                            <strong>
                              Market Hypothesis (Confidence:{' '}
                              {niche.confidenceScore ?? 'N/A'}%):
                            </strong>{' '}
                            {niche.marketHypothesis}
                          </div>
                        )}
                        {/* AI strategy note */}
                        {niche.aiReasoning && !isAutoAdded && (
                          <div className="text-blue-700">
                            <strong>AI Strategy Note:</strong>{' '}
                            {niche.aiReasoning}
                          </div>
                        )}
                        {/* Research citations */}
                        {niche.researchCitations &&
                          niche.researchCitations.length > 0 && (
                            <div className="text-blue-700 pt-0.5">
                              <strong>Research Citations:</strong>
                              <ul className="list-disc list-inside mt-0.5">
                                {niche.researchCitations.map((url, i) => (
                                  <li key={i}>
                                    <a
                                      href={url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="hover:underline break-all"
                                    >
                                      {url}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}

            {filteredNiches.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  {selectedPipelineId === 'all'
                    ? 'No niches found. Create one above!'
                    : 'No niches for this pipeline.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
