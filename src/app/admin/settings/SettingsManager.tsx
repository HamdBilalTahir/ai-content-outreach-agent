'use client';

import { useState } from 'react';
import type { SystemSettings } from '../../../../lib/types';
import { useRouter } from 'next/navigation';

export default function SettingsManager({
  initialSettings,
  connectedNumber,
}: {
  initialSettings: SystemSettings;
  connectedNumber: string | null;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<SystemSettings>(initialSettings);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const handleSave = async () => {
    setIsSubmitting(true);
    setSuccessMsg('');
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (!res.ok) throw new Error('Failed to update settings');
      setSuccessMsg('Settings saved successfully!');
      router.refresh();
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    } finally {
      setIsSubmitting(false);
      setTimeout(() => setSuccessMsg(''), 3000);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setSettings((prev) => ({
      ...prev,
      [name]:
        type === 'checkbox'
          ? checked
          : type === 'number'
            ? Number(value)
            : value,
    }));
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">System Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage crawler and dispatcher limits, batch sizes, and toggle
          sub-systems on or off. Note: Scheduling times are managed in Vercel
          cron.
        </p>
      </div>

      {connectedNumber ? (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 shadow-sm flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-green-900">
              Active WhatsApp Connection
            </h2>
            <p className="text-sm text-green-700">
              Messages will be sent from{' '}
              <span className="font-mono font-bold">{connectedNumber}</span>
            </p>
          </div>
          <a
            href="/admin/connect"
            className="text-sm font-medium text-green-600 hover:text-green-500"
          >
            Manage &rarr;
          </a>
        </div>
      ) : (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 shadow-sm flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-yellow-900">
              No WhatsApp Connection
            </h2>
            <p className="text-sm text-yellow-700">
              The dispatcher cannot send messages without an active connection.
            </p>
          </div>
          <a
            href="/admin/connect"
            className="text-sm font-medium text-yellow-600 hover:text-yellow-500"
          >
            Connect &rarr;
          </a>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-6">
        {/* Toggles */}
        <div className="space-y-4 border-b border-gray-200 pb-6">
          <h2 className="text-sm font-semibold text-gray-900">
            Pipeline Toggles
          </h2>

          <div className="flex items-center">
            <input
              type="checkbox"
              id="crawlEnabled"
              name="crawlEnabled"
              checked={settings.crawlEnabled}
              onChange={handleChange}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
            />
            <label
              htmlFor="crawlEnabled"
              className="ml-3 block text-sm leading-6 text-gray-900"
            >
              Enable Auto-Crawler
            </label>
          </div>

          <div className="flex items-center">
            <input
              type="checkbox"
              id="dispatchEnabled"
              name="dispatchEnabled"
              checked={settings.dispatchEnabled}
              onChange={handleChange}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
            />
            <label
              htmlFor="dispatchEnabled"
              className="ml-3 block text-sm leading-6 text-gray-900"
            >
              Enable Auto-Dispatcher
            </label>
          </div>
        </div>

        {/* Limits & Schedules */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">
            Pipeline Limits & Schedules
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="crawlScheduleHour"
                className="block text-sm font-medium leading-6 text-gray-900"
              >
                Crawl Schedule Hour (UTC)
              </label>
              <div className="mt-2">
                <input
                  type="number"
                  name="crawlScheduleHour"
                  id="crawlScheduleHour"
                  min="0"
                  max="23"
                  value={settings.crawlScheduleHour}
                  onChange={handleChange}
                  className="block w-full sm:w-32 rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6 border px-3"
                />
              </div>
              <p className="mt-2 text-sm text-gray-500">
                Hour of the day to automatically run crawler.
              </p>
            </div>

            <div>
              <label
                htmlFor="dispatchScheduleHour"
                className="block text-sm font-medium leading-6 text-gray-900"
              >
                Dispatch Schedule Hour (UTC)
              </label>
              <div className="mt-2">
                <input
                  type="number"
                  name="dispatchScheduleHour"
                  id="dispatchScheduleHour"
                  min="0"
                  max="23"
                  value={settings.dispatchScheduleHour}
                  onChange={handleChange}
                  className="block w-full sm:w-32 rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6 border px-3"
                />
              </div>
              <p className="mt-2 text-sm text-gray-500">
                Hour of the day to automatically dispatch messages.
              </p>
            </div>
          </div>

          <div>
            <label
              htmlFor="maxConcurrentPipelines"
              className="block text-sm font-medium leading-6 text-gray-900"
            >
              Max Concurrent Crawl Pipelines
            </label>
            <div className="mt-2">
              <input
                type="number"
                name="maxConcurrentPipelines"
                id="maxConcurrentPipelines"
                min="1"
                max="20"
                value={settings.maxConcurrentPipelines}
                onChange={handleChange}
                className="block w-full sm:w-32 rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6 border px-3"
              />
            </div>
            <p className="mt-2 text-sm text-gray-500">
              How many niches to crawl simultaneously.
            </p>
          </div>

          <div>
            <label
              htmlFor="dispatchBatchSize"
              className="block text-sm font-medium leading-6 text-gray-900"
            >
              WhatsApp Dispatch Batch Size
            </label>
            <div className="mt-2">
              <input
                type="number"
                name="dispatchBatchSize"
                id="dispatchBatchSize"
                min="1"
                max="100"
                value={settings.dispatchBatchSize}
                onChange={handleChange}
                className="block w-full sm:w-32 rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6 border px-3"
              />
            </div>
            <p className="mt-2 text-sm text-gray-500">
              Max number of leads to contact per dispatch run.
            </p>
          </div>
        </div>

        <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
          <span className="text-sm text-green-600 font-medium">
            {successMsg}
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSubmitting}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* Manual Triggers */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Manual Triggers</h2>
        <p className="text-sm text-gray-500 mb-4">
          Trigger the pipelines immediately, bypassing the automated schedule.
          Note: Ensure pipelines are enabled above.
        </p>
        <div className="flex space-x-4">
          <button
            type="button"
            onClick={async () => {
              try {
                const res = await fetch('/api/admin/run-crawl', {
                  method: 'POST',
                });
                const data = await res.json();
                alert(
                  data.message ||
                    (data.success ? 'Crawl finished!' : 'Crawl failed')
                );
              } catch (e) {
                alert('Request failed');
              }
            }}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
          >
            Run Crawl Now
          </button>

          <button
            type="button"
            onClick={async () => {
              try {
                const res = await fetch('/api/admin/run-dispatch', {
                  method: 'POST',
                });
                const data = await res.json();
                alert(
                  data.message ||
                    (data.success ? 'Dispatch finished!' : 'Dispatch failed')
                );
              } catch (e) {
                alert('Request failed');
              }
            }}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
          >
            Run Dispatch Now
          </button>
        </div>
      </div>
    </div>
  );
}
