'use client';

import { useState } from 'react';
import type { Lead } from '../../../../../lib/types';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

export default function OutcomeCard({ lead }: { lead: Lead }) {
  const router = useRouter();
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!selectedOutcome) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/admin/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          leadId: lead.id,
          outcome: selectedOutcome,
          notes,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit feedback');
      }

      router.refresh();
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm flex flex-col space-y-6">
      {/* Header Info */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{lead.brandName}</h2>
          <div className="mt-1 flex flex-col space-y-1 sm:flex-row sm:space-y-0 sm:space-x-4 text-sm text-gray-600">
            <a
              href={lead.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              {lead.websiteUrl}
            </a>
            <span className="hidden sm:inline">&bull;</span>
            <span className="font-mono">{lead.whatsappNumber}</span>
          </div>
        </div>
        <div>
          <span className="inline-flex items-center rounded-md bg-purple-50 px-2 py-1 text-xs font-medium text-purple-700 ring-1 ring-inset ring-purple-700/10">
            Angle: {lead.pitchAngle || 'Unknown'}
          </span>
        </div>
      </div>

      {/* Product Image and Pitch */}
      <div className="flex flex-col md:flex-row gap-6">
        {lead.targetProductImageUrl && (
          <div className="flex-shrink-0 relative h-32 w-32 rounded-lg overflow-hidden border border-gray-200">
            <Image
              src={lead.targetProductImageUrl}
              alt={lead.targetProductName || 'Product'}
              fill
              className="object-cover"
              unoptimized
            />
          </div>
        )}
        <div className="flex-1 rounded-md bg-gray-50 p-4 border border-gray-200">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Generated Pitch
          </h3>
          <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans max-h-48 overflow-y-auto">
            {lead.generatedPitch || 'No pitch available.'}
          </pre>
        </div>
      </div>

      {/* Outcome Selection */}
      <div className="pt-4 border-t border-gray-100">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Log Outcome</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['Closed', 'Negotiating', 'Ghosted', 'Rejected'] as const).map(
            (outcome) => (
              <button
                key={outcome}
                onClick={() => setSelectedOutcome(outcome)}
                className={`rounded-md px-3 py-2 text-sm font-semibold shadow-sm ring-1 ring-inset ${
                  selectedOutcome === outcome
                    ? 'bg-blue-600 text-white ring-blue-600'
                    : 'bg-white text-gray-900 ring-gray-300 hover:bg-gray-50'
                }`}
              >
                {outcome}
              </button>
            )
          )}
        </div>

        {/* Inline Notes & Confirm */}
        {selectedOutcome && (
          <div className="mt-4 space-y-4 rounded-md bg-gray-50 p-4 border border-gray-200">
            <div>
              <label
                htmlFor="notes"
                className="block text-sm font-medium leading-6 text-gray-900"
              >
                Notes (Optional)
              </label>
              <div className="mt-2">
                <textarea
                  id="notes"
                  name="notes"
                  rows={2}
                  className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any details about the response..."
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedOutcome(null);
                  setNotes('');
                }}
                className="text-sm font-semibold leading-6 text-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isSubmitting}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Logging...' : 'Confirm'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
