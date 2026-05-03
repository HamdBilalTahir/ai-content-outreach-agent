import { useState, useEffect } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../../../lib/firebase/client';

export default function LeadInspectorModal({
  lead,
  onClose,
  onSave,
  onRegenerate,
  niches,
  pipelines,
}: any) {
  const [whatsappNumber, setWhatsappNumber] = useState(
    lead.whatsappNumber || ''
  );
  const [draftMessage, setDraftMessage] = useState(lead.generatedPitch || '');
  const [regenNote, setRegenNote] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [rejectionReason, setRejectionReason] = useState(
    lead.sandboxRejectionReason || ''
  );
  const [isRejecting, setIsRejecting] = useState(false);

  const handleApprove = () => {
    onSave({
      whatsappNumber,
      generatedPitch: draftMessage,
      triageStatus: 'approved',
    });
  };

  const handleRejectClick = () => {
    setIsRejecting(true);
  };

  const handleConfirmReject = () => {
    onSave({
      whatsappNumber,
      generatedPitch: draftMessage,
      triageStatus: 'rejected',
      sandboxRejectionReason: rejectionReason,
    });
  };

  const handleRegenerate = async () => {
    if (!regenNote) return;
    setIsRegenerating(true);
    const newPitch = await onRegenerate(lead, regenNote);
    if (newPitch) {
      setDraftMessage(newPitch);
      setRegenNote('');
    }
    setIsRegenerating(false);
  };

  const [nicheName, setNicheName] = useState<string>('Loading...');

  useEffect(() => {
    const found =
      niches?.find((n: any) => n.id === lead.nicheId)?.name ||
      pipelines?.find((p: any) => p.id === lead.nicheId)?.name;
    if (found) {
      setNicheName(found);
    } else if (lead.nicheId && lead.nicheId !== 'auto') {
      getDoc(doc(db, 'niches', lead.nicheId))
        .then((snap) => {
          if (snap.exists() && snap.data().nicheName) {
            setNicheName(snap.data().nicheName);
          } else {
            setNicheName(lead.nicheId);
          }
        })
        .catch(() => setNicheName(lead.nicheId));
    } else {
      setNicheName(lead.nicheId || 'Unknown');
    }
  }, [lead.nicheId, niches, pipelines]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-6 max-w-3xl w-full flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold">Inspect Lead: {lead.brandName}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-black">
            ✕
          </button>
        </div>

        <div className="overflow-y-auto pr-2 space-y-4 flex-1">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-gray-500">Website URL</p>
              <a
                href={lead.websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-600 hover:underline"
              >
                {lead.websiteUrl}
              </a>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Gap Score</p>
              <p className="text-lg font-bold">{lead.socialMediaGapScore}/10</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Contact Number
            </label>
            <input
              type="text"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
            />
          </div>

          <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
            <h4 className="text-sm font-bold text-gray-900 mb-2">
              Lead Context
            </h4>
            <div className="space-y-2 text-sm text-gray-700">
              <p>
                <strong>Found via:</strong>{' '}
                {lead.crawlSource || 'Organic Search'}
              </p>
              <p>
                <strong>Scraping & Contact Fetching:</strong> Number fetched
                from{' '}
                {lead.instagramUrl
                  ? 'Instagram profile / Social'
                  : 'Website scraping'}
                .
              </p>
              <p>
                <strong>Why they are a fit:</strong>{' '}
                {lead.analystNarrative ||
                  `Identified with a gap score of ${lead.socialMediaGapScore}/10, indicating strong potential for outreach.`}{' '}
                This lead connects with the <strong>{nicheName}</strong> niche.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Draft Message
            </label>
            <textarea
              rows={4}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
              value={draftMessage}
              onChange={(e) => setDraftMessage(e.target.value)}
            />
          </div>

          <div className="bg-blue-50 p-3 rounded-md border border-blue-100">
            <label className="block text-sm font-medium text-blue-800">
              Unsure? Provide note to regenerate
            </label>
            <div className="flex mt-1 gap-2">
              <input
                type="text"
                placeholder="e.g. Too formal, make it more casual"
                className="block w-full rounded-md border-blue-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
                value={regenNote}
                onChange={(e) => setRegenNote(e.target.value)}
              />
              <button
                onClick={handleRegenerate}
                disabled={isRegenerating || !regenNote}
                className="px-3 py-1 bg-blue-600 text-white rounded text-sm whitespace-nowrap hover:bg-blue-500 disabled:opacity-50"
              >
                {isRegenerating ? 'Rewriting...' : 'Regenerate'}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 border-t pt-4">
          {isRejecting ? (
            <div className="mb-4 bg-red-50 p-4 rounded-md border border-red-100">
              <label className="block text-sm font-medium text-red-800">
                Reason for Rejection (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Not a relevant business, invalid contact info, etc."
                className="mt-1 block w-full rounded-md border-red-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm px-3 py-2 border bg-white"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
              />
              <p className="text-xs text-red-600 mt-1">
                This will be used to train the AI Strategist to avoid similar
                leads in the future.
              </p>
              <div className="flex justify-end gap-3 mt-3">
                <button
                  onClick={() => setIsRejecting(false)}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmReject}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 font-medium transition-colors"
                >
                  Confirm Rejection
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-3">
              <button
                onClick={handleRejectClick}
                className="px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 font-medium transition-colors"
              >
                Reject Lead
              </button>
              <button
                onClick={handleApprove}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500 font-medium transition-colors"
              >
                Approve & Save
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
