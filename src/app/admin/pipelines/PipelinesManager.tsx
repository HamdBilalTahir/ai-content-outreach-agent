'use client';

import React, { useState } from 'react';
import type { Pipeline, Connection } from '../../../../lib/types';
import { useRouter } from 'next/navigation';

export default function PipelinesManager({
  initialPipelines,
  connections,
}: {
  initialPipelines: Pipeline[];
  connections: Connection[];
}) {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'running' | 'paused' | 'stopped'>(
    'stopped'
  );
  const [connectionId, setConnectionId] = useState<string>('');
  const [overrideGlobalDeduplication, setOverrideGlobalDeduplication] =
    useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const startCreate = () => {
    setIsCreating(true);
    setEditingId(null);
    setName('');
    setDescription('');
    setStatus('stopped');
    setConnectionId('');
    setOverrideGlobalDeduplication(false);
  };

  const startEdit = (pipeline: Pipeline) => {
    setIsCreating(false);
    setEditingId(pipeline.id);
    setName(pipeline.name);
    setDescription(pipeline.description || '');
    setStatus(pipeline.status);
    setConnectionId(pipeline.connectionId || '');
    setOverrideGlobalDeduplication(
      pipeline.settings?.overrideGlobalDeduplication || false
    );
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    setIsSubmitting(true);
    try {
      if (isCreating) {
        await fetch('/api/admin/pipelines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
        });
      } else if (editingId) {
        await fetch('/api/admin/pipelines', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingId,
            description,
            status,
            connectionId: connectionId || null,
            settings: { overrideGlobalDeduplication },
          }),
        });
      }
      setIsCreating(false);
      setEditingId(null);
      router.refresh();
    } catch (err) {
      console.error(err);
      alert('Failed to save pipeline');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Pipelines</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage autonomous workflows. Each Pipeline is an independent
            ecosystem.
          </p>
        </div>
        <button
          onClick={startCreate}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
        >
          New Pipeline
        </button>
      </div>

      {(isCreating || editingId) && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm mb-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">
            {isCreating ? 'Create New Pipeline' : `Edit Pipeline: ${name}`}
          </h2>
          <div className="space-y-4">
            {isCreating && (
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                  placeholder="e.g. Roofing Campaign"
                />

                <label className="block text-sm font-medium text-gray-700 mt-4">
                  Search Instructions / Ideal Customer Profile
                </label>
                <p className="text-xs text-gray-500 mt-0.5">
                  Describe who you&apos;re targeting and the context the
                  strategy engine should search for — buyer types, qualifying
                  signals, disqualifiers, triggers, etc. This text drives the
                  web searches used to discover niches and leads, so the more
                  specific the better.
                </p>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={12}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                  placeholder={
                    'e.g. Ideal Customer Profile: Fencing Construction Services\n\n' +
                    'Primary buyers: property developers and builders (perimeter fencing, hoarding, repeat volume), facility/property managers (schools, warehouses, compounds — security & compliance driven), contractors/subcontractors needing a dependable install partner, and homeowners/small landlords (privacy, security, replacing a broken fence).\n\n' +
                    'Qualified signals: a defined site/property, rough linear footage needed, a trigger (new build, security incident, code requirement, damaged fence), budget authority, and a timeline.\n\n' +
                    'Disqualifiers: no actual property, "just getting ideas", expectations far below realistic cost.\n\n' +
                    'Track: fence type, material, scale (linear meters), application, trigger, timeline, decision-maker.'
                  }
                />
              </div>
            )}

            {editingId && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Status
                    </label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as any)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                    >
                      <option value="running">Running</option>
                      <option value="paused">Paused</option>
                      <option value="stopped">Stopped</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Sender Identity (Connection)
                    </label>
                    <select
                      value={connectionId}
                      onChange={(e) => setConnectionId(e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                    >
                      <option value="">-- No Connection --</option>
                      {connections.map((c) => (
                        <option
                          key={c.instanceId || c.id}
                          value={c.instanceId || c.id}
                        >
                          {c.phoneNumber} ({c.status})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Search Instructions / Ideal Customer Profile
                  </label>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Describe who you&apos;re targeting and the context the
                    strategy engine should search for — buyer types, qualifying
                    signals, disqualifiers, triggers, etc. This text drives the
                    niches the agent defines and the web searches used to
                    discover leads, so the more specific the better.
                  </p>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={12}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                    placeholder="Describe your ideal customer profile and what the agent should search for..."
                  />
                </div>

                <div className="flex items-center mt-4">
                  <input
                    type="checkbox"
                    id="overrideDedup"
                    checked={overrideGlobalDeduplication}
                    onChange={(e) =>
                      setOverrideGlobalDeduplication(e.target.checked)
                    }
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                  />
                  <label
                    htmlFor="overrideDedup"
                    className="ml-3 block text-sm leading-6 text-gray-900"
                  >
                    Override Global Deduplication (Allow messaging leads
                    contacted by other pipelines)
                  </label>
                </div>
              </>
            )}

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
                disabled={isSubmitting || (isCreating && !name)}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {initialPipelines.map((pipeline) => (
          <div
            key={pipeline.id}
            className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm flex flex-col"
          >
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                {pipeline.name}
              </h3>
              <span
                className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                  pipeline.status === 'running'
                    ? 'bg-green-50 text-green-700 ring-green-600/20'
                    : pipeline.status === 'paused'
                      ? 'bg-yellow-50 text-yellow-800 ring-yellow-600/20'
                      : 'bg-red-50 text-red-700 ring-red-600/10'
                }`}
              >
                {pipeline.status.toUpperCase()}
              </span>
            </div>

            {pipeline.description && (
              <p className="mb-4 text-sm text-gray-600 line-clamp-4 whitespace-pre-wrap">
                {pipeline.description}
              </p>
            )}

            {(pipeline.settings as any)?.conceptStrategy && (
              <div className="mt-4 bg-gray-50 p-3 rounded text-sm text-gray-700">
                <div className="font-semibold mb-1">Detailed Goal</div>
                <p className="mb-2 text-xs">{pipeline.description}</p>
                <div className="font-semibold mb-1">Concept Strategy</div>
                <p className="mb-2 text-xs">
                  {(pipeline.settings as any).conceptStrategy}
                </p>
                <div className="font-semibold mb-1">Source URLs</div>
                <p className="text-xs break-all">
                  {(pipeline.settings as any).sourceUrls}
                </p>
              </div>
            )}

            <div className="mt-auto pt-4 border-t border-gray-100 flex justify-between items-center">
              <div className="text-sm text-gray-500">
                Connection:{' '}
                {pipeline.connectionId
                  ? connections.find(
                      (c) => (c.instanceId || c.id) === pipeline.connectionId
                    )?.phoneNumber || 'Unknown'
                  : 'None'}
              </div>
              <button
                onClick={() => startEdit(pipeline)}
                className="text-sm font-medium text-blue-600 hover:text-blue-500"
              >
                Edit / Control Room &rarr;
              </button>
            </div>
          </div>
        ))}
        {initialPipelines.length === 0 && !isCreating && (
          <div className="col-span-full py-12 text-center border-2 border-dashed border-gray-300 rounded-lg">
            <p className="text-gray-500">No pipelines created yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
