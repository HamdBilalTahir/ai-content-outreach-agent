'use client';

import { useState } from 'react';
import type { Niche } from '../../../../lib/types';
import { useRouter } from 'next/navigation';

export default function NichesManager({
  initialNiches,
}: {
  initialNiches: Niche[];
}) {
  const router = useRouter();
  const [niches, setNiches] = useState<Niche[]>(initialNiches);
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form states
  const [nicheName, setNicheName] = useState('');
  const [seedUrls, setSeedUrls] = useState('');
  const [crawlPriority, setCrawlPriority] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRunningLoop, setIsRunningLoop] = useState(false);

  const startCreate = () => {
    setIsCreating(true);
    setEditingId(null);
    setNicheName('');
    setSeedUrls('');
    setCrawlPriority(5);
  };

  const startEdit = (niche: Niche) => {
    setIsCreating(false);
    setEditingId(niche.id);
    setNicheName(niche.nicheName);
    setSeedUrls((niche.seedUrls || []).join('\n'));
    setCrawlPriority(niche.crawlPriority);
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
      if (isCreating) {
        await fetch('/api/admin/niches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nicheName, seedUrls: urls, crawlPriority }),
        });
      } else if (editingId) {
        await fetch('/api/admin/niches', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingId,
            seedUrls: urls,
            crawlPriority,
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            Niches Manager
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            View and override agent decisions, manage seed URLs, and manually
            trigger the feedback loop.
          </p>
        </div>
        <div className="flex space-x-3">
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
            <div className="flex justify-end space-x-3 pt-4">
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

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Niche</th>
              <th className="px-4 py-3 text-right">Priority</th>
              <th className="px-4 py-3 text-right">Avg Gap Score</th>
              <th className="px-4 py-3 text-right">Close Rate</th>
              <th className="px-4 py-3 text-left">Last Crawled</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialNiches.map((niche) => (
              <tr key={niche.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">
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
                <td className="px-4 py-3 text-gray-500">
                  {niche.lastCrawled
                    ? new Date(niche.lastCrawled as any).toLocaleString()
                    : 'Never'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => startEdit(niche)}
                    className="text-blue-600 hover:text-blue-900 font-medium text-xs"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {initialNiches.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  No niches found. Create one above!
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
