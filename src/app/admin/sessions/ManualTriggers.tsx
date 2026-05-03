'use client';

import React, { useState, useEffect } from 'react';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from '../../../../lib/firebase/client';
import type { CrawlSession } from '../../../../lib/types';

import LeadInspectorModal from './LeadInspectorModal';
import {
  collection,
  query,
  where,
  onSnapshot as firestoreOnSnapshot,
  getDocs,
} from 'firebase/firestore';

export default function ManualTriggers({
  niches,
  pipelines,
}: {
  niches: { id: string; name: string }[];
  pipelines: { id: string; name: string }[];
}) {
  const [forceNicheId, setForceNicheId] = useState<string>('');
  const [maxTargets, setMaxTargets] = useState<number>(5);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<string>('idle');
  const [loading, setLoading] = useState(false);
  const [qualifiedLeads, setQualifiedLeads] = useState<any[]>([]);
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const logsEndRef = React.useRef<HTMLDivElement>(null);

  // Setup Modal State
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupStep, setSetupStep] = useState<1 | 2>(1);
  const [pipelineName, setPipelineName] = useState('');
  const [pipelineDesc, setPipelineDesc] = useState('');
  const [userUrls, setUserUrls] = useState('');
  const [clientSeedUrls, setClientSeedUrls] = useState('');
  const [detailedGoal, setDetailedGoal] = useState('');
  const [conceptStrategy, setConceptStrategy] = useState('');
  const [generatingStrategy, setGeneratingStrategy] = useState(false);
  const [images, setImages] = useState<string[]>([]);

  // Modals
  const [showPlaybookModal, setShowPlaybookModal] = useState(false);
  const [playbooks, setPlaybooks] = useState<any[]>([]);
  const [showInspectorModal, setShowInspectorModal] = useState(false);
  const [inspectingLead, setInspectingLead] = useState<any | null>(null);
  const [editedPitch, setEditedPitch] = useState('');

  // We change state to handle AgentLog[] instead of string[]
  const [agentLogs, setAgentLogs] = useState<any[]>([]);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'leads' | 'rejected'>('leads');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [viewingPlaybookContent, setViewingPlaybookContent] = useState<
    string | null
  >(null);
  const [viewingPlaybookTitle, setViewingPlaybookTitle] = useState<string>('');
  const [viewingPlaybook, setViewingPlaybook] = useState<any>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [localOverrides, setLocalOverrides] = useState<Record<string, any>>({});
  const [successAlert, setSuccessAlert] = useState<string | null>(null);

  const logsContainerRef = React.useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const isAutoScrolling = React.useRef(false);

  useEffect(() => {
    if (successAlert) {
      const timer = setTimeout(() => {
        setSuccessAlert(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [successAlert]);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      isAutoScrolling.current = true;
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => {
        isAutoScrolling.current = false;
      }, 500);
    }
  }, [agentLogs, autoScroll]);

  const handleLogsScroll = () => {
    if (!logsContainerRef.current || isAutoScrolling.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    setAutoScroll(isAtBottom);
  };

  useEffect(() => {
    if (!sessionId) return;

    let sessionRef: any;
    if (sessionId.startsWith('sandbox:')) {
      const [, pId, rId] = sessionId.split(':');
      sessionRef = doc(db, 'pipelines', pId, 'sandbox_runs', rId);
    } else {
      sessionRef = doc(db, 'crawlSessions', sessionId);
    }

    const unsubSession = onSnapshot(sessionRef, (docSnap: any) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as CrawlSession;
        setAgentLogs(data.agentLogs || []);
        setStatus(data.sessionStatus || 'idle');
      }
    });

    let leadsQueryRef: any;
    if (sessionId.startsWith('sandbox:')) {
      // Sandbox leads: leads/sandbox_{pipelineId}_{runId}/items (scoped per run, no filter needed)
      const [, pId, rId] = sessionId.split(':');
      const containerId = `sandbox_${pId}_${rId}`;
      leadsQueryRef = collection(db, 'leads', containerId, 'items');
    } else {
      leadsQueryRef = query(
        collection(db, 'leads'),
        where('crawlSessionId', '==', sessionId)
      );
    }

    const unsubLeads = firestoreOnSnapshot(leadsQueryRef, (snapshot: any) => {
      const leads = snapshot.docs.map((d: any) => {
        let finalId = d.id;
        if (sessionId.startsWith('sandbox:')) {
          const [, pId, rId] = sessionId.split(':');
          finalId = `sandbox:${pId}:${rId}:${d.id}`;
        }
        return { id: finalId, ...d.data() };
      });
      // Show Qualified, incomplete (no phone), and Failed (rejected) leads in sandbox
      setQualifiedLeads(
        leads.filter(
          (l: any) =>
            l.status === 'Qualified' ||
            l.status === 'incomplete' ||
            l.status === 'Failed'
        )
      );
    });

    return () => {
      unsubSession();
      unsubLeads();
    };
  }, [sessionId]);

  const handleStartClick = () => {
    if (activePipelineId && activePipelineId !== 'NEW') {
      // Direct start without creating a new pipeline
      submitDirectStart();
    } else {
      setSetupStep(1);
      setShowSetupModal(true);
    }
  };

  const handlePipelineSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'NEW') {
      setActivePipelineId('');
      setSessionId(null);
      setStatus('idle');
      setAgentLogs([]);
      setQualifiedLeads([]);
      setSetupStep(1);
      setShowSetupModal(true);
    } else {
      setActivePipelineId(val);
      // Fetch latest sandbox run for this pipeline
      const fetchLatestSession = async () => {
        const q = query(
          collection(db, 'pipelines', val, 'sandbox_runs'),
          where('isSandbox', '==', true)
        );
        const snapshot = await getDocs(q);
        if (!snapshot.empty) {
          // Sort client-side to find the most recent
          const docs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
          // Filter to only include sessions in an active state (not 'Ended')
          const activeDocs = docs.filter(
            (d: any) => d.sessionStatus !== 'Ended'
          );
          if (activeDocs.length > 0) {
            activeDocs.sort((a: any, b: any) => {
              const aTime = a.startedAt?.toMillis?.() || 0;
              const bTime = b.startedAt?.toMillis?.() || 0;
              return bTime - aTime;
            });
            const latest = activeDocs[0];
            setSessionId(`sandbox:${val}:${latest.id}`);
          } else {
            setSessionId(null);
            setStatus('idle');
            setAgentLogs([]);
            setQualifiedLeads([]);
          }
        } else {
          setSessionId(null);
          setStatus('idle');
          setAgentLogs([]);
          setQualifiedLeads([]);
        }
      };
      fetchLatestSession();
    }
  };

  const submitDirectStart = async () => {
    setLoading(true);
    setAgentLogs([]);
    setQualifiedLeads([]);
    setSelectedLeads(new Set());
    setStatus('Starting...');
    try {
      const res = await fetch('/api/admin/run-crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forceNicheId: forceNicheId || undefined,
          maxTargets,
          isSandbox: true,
          pipelineId: activePipelineId,
        }),
      });
      const data = await res.json();
      if (data.sessionId) {
        setSessionId(data.sessionId);
      } else {
        alert(data.message || data.error || 'Failed to start');
        setStatus('Failed');
      }
    } catch (e) {
      alert('Request failed');
      setStatus('Failed');
    }
    setLoading(false);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (images.length + files.length > 10) {
      alert('You can only upload up to 10 images');
      return;
    }

    files.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImages((prev) => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleGenerateStrategy = async () => {
    if (!pipelineName || !pipelineDesc)
      return alert('Please fill in the required fields (Name and Rough Goal)');
    setGeneratingStrategy(true);
    try {
      const res = await fetch('/api/admin/generate-strategy-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rough_goal: pipelineDesc,
          user_urls: userUrls,
          images,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setDetailedGoal(data.data.detailed_goal);
        setConceptStrategy(data.data.concept_strategy);
        setSetupStep(2);
      } else {
        alert('Failed to generate strategy');
      }
    } catch (e) {
      alert('Failed to generate strategy');
    }
    setGeneratingStrategy(false);
  };

  const submitSetup = async () => {
    setShowSetupModal(false);
    setLoading(true);
    setAgentLogs([]);
    setQualifiedLeads([]);
    setSelectedLeads(new Set());
    setStatus('Starting...');
    try {
      // 1. Init pipeline & playbooks
      const pRes = await fetch('/api/admin/init-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: pipelineName,
          detailed_goal: detailedGoal,
          concept_strategy: conceptStrategy,
          user_urls: userUrls,
          clientSeedUrls,
        }),
      });
      const pData = await pRes.json();
      const pId = pData.pipelineId;
      setActivePipelineId(pId);

      // 2. Run crawl
      const res = await fetch('/api/admin/run-crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forceNicheId: forceNicheId || undefined,
          maxTargets,
          isSandbox: true,
          pipelineId: pId,
        }),
      });
      const data = await res.json();
      if (data.sessionId) {
        setSessionId(data.sessionId);
      } else {
        alert(data.message || data.error || 'Failed to start');
        setStatus('Failed');
      }
    } catch (e) {
      alert('Request failed');
      setStatus('Failed');
    }
    setLoading(false);
  };

  const handleStop = async () => {
    if (!sessionId) return;
    try {
      let sessionRef: any;
      if (sessionId.startsWith('sandbox:')) {
        const [, pId, rId] = sessionId.split(':');
        sessionRef = doc(db, 'pipelines', pId, 'sandbox_runs', rId);
      } else {
        sessionRef = doc(db, 'crawlSessions', sessionId);
      }
      await updateDoc(sessionRef, {
        sessionStatus: 'Stopped',
      });
      setStatus('Stopped');
    } catch (e) {
      alert('Failed to stop session');
    }
  };

  const handleManualDispatch = async () => {
    if (selectedLeads.size === 0) return;
    setDispatching(true);
    try {
      const res = await fetch('/api/admin/dispatch-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: Array.from(selectedLeads) }),
      });
      const data = await res.json();
      alert(
        data.message ||
          (data.success ? 'Dispatch triggered!' : 'Dispatch failed')
      );
      if (data.success) {
        setSelectedLeads(new Set());
      }
    } catch (e) {
      alert('Dispatch request failed');
    }
    setDispatching(false);
  };

  const isRunning = status === 'Running' || status === 'Starting...';

  const fetchPlaybooks = async () => {
    if (!activePipelineId) return alert('No active pipeline ID');
    setShowPlaybookModal(true);
    setViewingPlaybookContent(null);
    setViewingPlaybook(null);
    try {
      const q = query(
        collection(db, 'intelligence'),
        where('pipelineId', '==', activePipelineId)
      );
      const pSnapshot = await firestoreOnSnapshot(q, (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setPlaybooks(data);
      });
    } catch (e) {
      console.error(e);
    }
  };

  const openInspector = (lead: any) => {
    setInspectingLead(lead);
    setEditedPitch(lead.generatedPitch || '');
    setShowInspectorModal(true);
  };

  const handleSaveInspectorDraft = async (updates: any) => {
    if (!inspectingLead) return;
    setLocalOverrides((prev) => ({
      ...prev,
      [inspectingLead.id]: {
        ...prev[inspectingLead.id],
        ...updates,
      },
    }));
    setShowInspectorModal(false);

    // If it's a triage status change, log it via the backend
    if (updates.triageStatus) {
      try {
        await fetch('/api/admin/triage-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leadId: inspectingLead.id,
            sessionId: sessionId,
            triageStatus: updates.triageStatus,
            sandboxRejectionReason: updates.sandboxRejectionReason,
            brandName: inspectingLead.brandName || inspectingLead.websiteUrl,
          }),
        });
      } catch (e) {
        console.error('Failed to log triage status', e);
      }
    }
  };

  const handleRegeneratePitch = async (lead: any, note: string) => {
    try {
      const res = await fetch('/api/admin/regenerate-pitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: lead.id,
          note,
          currentPitch: lead.generatedPitch,
        }),
      });
      const data = await res.json();
      if (data.success) {
        return data.newPitch;
      } else {
        alert('Failed to regenerate: ' + data.error);
      }
    } catch (e) {
      alert('Request failed');
    }
    return null;
  };

  const displayLeads = qualifiedLeads.map((lead) => {
    if (localOverrides[lead.id]) {
      return { ...lead, ...localOverrides[lead.id] };
    }
    return lead;
  });

  const handleFinalizeSandbox = async () => {
    if (!activePipelineId || !sessionId) return;
    setDispatching(true);
    try {
      const finalLeads = displayLeads
        .filter((l) => selectedLeads.has(l.id) || l.triageStatus === 'rejected')
        .map((l) => {
          if (selectedLeads.has(l.id)) {
            return { ...l, triageStatus: 'approved' };
          }
          return l;
        });

      const res = await fetch('/api/admin/finalize-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineId: activePipelineId,
          sessionId,
          candidates: finalLeads,
        }),
      });
      const data = await res.json();
      if (data.success) {
        // Optimistically clear the UI to empty state since DB is updated in background
        setSuccessAlert(
          'Sandbox session finalized and approved leads dispatched!'
        );
        setStatus('idle');
        setSelectedLeads(new Set());
        setSessionId(null);
        setActivePipelineId('');
        setAgentLogs([]);
        setQualifiedLeads([]);
      } else {
        alert('Finalization failed: ' + data.error);
      }
    } catch (e) {
      alert('Request failed');
    }
    setDispatching(false);
  };

  const handleViewPlaybook = async (pb: any) => {
    try {
      setViewingPlaybook(pb);
      setViewingPlaybookTitle(`Role: ${pb.agentRole} (v${pb.version})`);
      setViewingPlaybookContent('Loading content...');
      const res = await fetch(pb.blobUrl);
      const text = await res.text();
      setViewingPlaybookContent(text);
    } catch (err) {
      setViewingPlaybookContent('Failed to load content.');
    }
  };

  const handleStopAndSynthesize = async () => {
    if (!sessionId || !activePipelineId) return;
    setSynthesizing(true);
    setStatus('Synthesizing...');
    try {
      // Stop session
      let sessionRef: any;
      if (sessionId.startsWith('sandbox:')) {
        const [, pId, rId] = sessionId.split(':');
        sessionRef = doc(db, 'pipelines', pId, 'sandbox_runs', rId);
      } else {
        sessionRef = doc(db, 'crawlSessions', sessionId);
      }
      await updateDoc(sessionRef, {
        sessionStatus: 'Stopped',
      });

      // Pass the local override state so the backend knows what we rejected
      const finalLeads = displayLeads.filter(
        (l) => l.triageStatus === 'approved' || l.triageStatus === 'rejected'
      );

      // Trigger synthesis
      const res = await fetch('/api/admin/synthesize-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineId: activePipelineId,
          runId: sessionId,
          candidates: finalLeads,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('✅ Sandbox Ended. Playbooks successfully updated.');
      } else {
        setStatus('Failed to synthesize.');
      }
    } catch (e) {
      setStatus('Failed to synthesize.');
    }
    setSynthesizing(false);
  };

  return (
    <div className="space-y-6 relative">
      {successAlert && (
        <div className="fixed top-4 right-4 z-50 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded shadow-lg transition-opacity duration-500 flex items-center gap-2">
          <svg
            className="w-5 h-5 text-green-500"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
          <span className="font-medium">{successAlert}</span>
        </div>
      )}

      {showSetupModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full space-y-4">
            <h3 className="text-lg font-bold">New Sandbox Run</h3>

            {setupStep === 1 ? (
              <>
                <div className="grid grid-cols-1 gap-y-4">
                  <div>
                    <label className="block text-sm font-medium leading-6 text-gray-900">
                      Pipeline Name <span className="text-red-500">*</span>
                    </label>
                    <div className="mt-1">
                      <input
                        value={pipelineName}
                        onChange={(e) => setPipelineName(e.target.value)}
                        className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                        placeholder="e.g. Texas Roofers Q3"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium leading-6 text-gray-900">
                      Rough Goal <span className="text-red-500">*</span>
                    </label>
                    <div className="mt-1">
                      <textarea
                        value={pipelineDesc}
                        onChange={(e) => setPipelineDesc(e.target.value)}
                        rows={3}
                        className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                        placeholder="Testing aggressive hooks..."
                      ></textarea>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium leading-6 text-gray-900">
                      Your Business Links (comma separated){' '}
                      <span className="text-gray-400 font-normal">
                        (Optional)
                      </span>
                    </label>
                    <div className="mt-1">
                      <input
                        value={userUrls}
                        onChange={(e) => setUserUrls(e.target.value)}
                        className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                        placeholder="https://mybusiness.com"
                      />
                      <p className="text-xs text-gray-500 mt-2">
                        Note: We don't support Instagram links. Only web pages.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium leading-6 text-gray-900">
                      Who are your best current clients? (Paste 1-3 URLs){' '}
                      <span className="text-gray-400 font-normal">
                        (Optional)
                      </span>
                    </label>
                    <div className="mt-1">
                      <input
                        value={clientSeedUrls}
                        onChange={(e) => setClientSeedUrls(e.target.value)}
                        className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                        placeholder="https://client1.com, https://client2.com"
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium leading-6 text-gray-900">
                    Upload Images (Max 10){' '}
                    <span className="text-gray-400 font-normal">
                      (Optional)
                    </span>
                  </label>
                  <div className="mt-2 flex justify-center rounded-lg border border-dashed border-gray-900/25 px-6 py-6">
                    <div className="text-center">
                      <svg
                        className="mx-auto h-12 w-12 text-gray-300"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <div className="mt-4 flex text-sm leading-6 text-gray-600 justify-center">
                        <label
                          htmlFor="file-upload"
                          className="relative cursor-pointer rounded-md bg-white font-semibold text-indigo-600 focus-within:outline-none focus-within:ring-2 focus-within:ring-indigo-600 focus-within:ring-offset-2 hover:text-indigo-500"
                        >
                          <span>Upload files</span>
                          <input
                            id="file-upload"
                            name="file-upload"
                            type="file"
                            multiple
                            accept="image/*"
                            onChange={handleImageUpload}
                            className="sr-only"
                          />
                        </label>
                        <p className="pl-1">or drag and drop</p>
                      </div>
                      <p className="text-xs leading-5 text-gray-600">
                        PNG, JPG, GIF up to 10MB
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        Note: We don't support Instagram links. Only web pages.
                      </p>
                    </div>
                  </div>
                  {images.length > 0 && (
                    <div className="mt-4 grid grid-cols-5 gap-4">
                      {images.map((img, i) => (
                        <div
                          key={i}
                          className="relative group rounded-lg overflow-hidden ring-1 ring-black/10"
                        >
                          <img
                            src={img}
                            alt="preview"
                            className="h-20 w-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setImages(images.filter((_, idx) => idx !== i))
                            }
                            className="absolute top-1 right-1 bg-red-600/80 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              fill="none"
                              viewBox="0 0 24 24"
                              strokeWidth={2}
                              stroke="currentColor"
                              className="w-3 h-3"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowSetupModal(false)}
                    className="px-4 py-2 border rounded text-gray-600"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleGenerateStrategy}
                    disabled={generatingStrategy}
                    className="px-4 py-2 bg-indigo-600 text-white rounded disabled:opacity-50"
                  >
                    {generatingStrategy
                      ? 'AI is thinking...'
                      : '✨ Generate Strategy'}
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium leading-6 text-gray-900">
                    Detailed Goal
                  </label>
                  <div className="mt-1">
                    <textarea
                      value={detailedGoal}
                      onChange={(e) => setDetailedGoal(e.target.value)}
                      rows={4}
                      className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6 font-mono"
                    ></textarea>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium leading-6 text-gray-900">
                    Initial Concept Strategy
                  </label>
                  <div className="mt-1">
                    <textarea
                      value={conceptStrategy}
                      onChange={(e) => setConceptStrategy(e.target.value)}
                      rows={6}
                      className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6 font-mono"
                    ></textarea>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setSetupStep(1)}
                    className="px-4 py-2 border rounded text-gray-600 hover:bg-gray-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={submitSetup}
                    className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 shadow-sm"
                  >
                    Approve & Create Pipeline
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showPlaybookModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-3xl w-full h-[80vh] flex flex-col space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold">
                {viewingPlaybookContent !== null
                  ? viewingPlaybookTitle
                  : `Active Playbooks (Pipeline ${activePipelineId})`}
              </h3>
              <button
                onClick={() => {
                  if (viewingPlaybookContent !== null) {
                    setViewingPlaybookContent(null);
                    setViewingPlaybook(null);
                  } else {
                    setShowPlaybookModal(false);
                  }
                }}
                className="text-gray-500 hover:text-black"
              >
                {viewingPlaybookContent !== null ? '← Back' : '✕'}
              </button>
            </div>
            <div className="flex-1 overflow-auto space-y-6">
              {viewingPlaybookContent !== null ? (
                <div className="flex flex-col h-full space-y-4">
                  <div className="bg-gray-50 p-4 border rounded flex-1 overflow-y-auto">
                    <pre className="whitespace-pre-wrap font-mono text-sm text-gray-800">
                      {viewingPlaybookContent}
                    </pre>
                  </div>
                  {viewingPlaybook && (
                    <div className="text-xs text-gray-500 border-t pt-2">
                      <p>
                        <strong>Last Updated:</strong>{' '}
                        {(() => {
                          const lu = viewingPlaybook.lastUpdated;
                          if (!lu) return 'Unknown';
                          if (typeof lu.toDate === 'function')
                            return lu.toDate().toLocaleString();
                          if (lu.seconds)
                            return new Date(lu.seconds * 1000).toLocaleString();
                          return new Date(lu).toLocaleString();
                        })()}
                      </p>
                      <p>
                        <strong>Last Change:</strong>{' '}
                        {viewingPlaybook.lastChangeNote ||
                          'Auto-updated from latest synthesis run.'}
                      </p>
                    </div>
                  )}
                </div>
              ) : playbooks.length === 0 ? (
                <p className="text-gray-500">No playbooks found yet.</p>
              ) : (
                playbooks.map((pb) => (
                  <div key={pb.id} className="border p-4 rounded bg-gray-50">
                    <h4 className="font-bold text-sm text-indigo-600 mb-2">
                      Role: {pb.agentRole} (v{pb.version})
                    </h4>
                    <button
                      onClick={() => handleViewPlaybook(pb)}
                      className="text-blue-500 text-xs hover:underline cursor-pointer"
                    >
                      View File
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showInspectorModal && inspectingLead && (
        <LeadInspectorModal
          lead={
            localOverrides[inspectingLead.id]
              ? { ...inspectingLead, ...localOverrides[inspectingLead.id] }
              : inspectingLead
          }
          onClose={() => setShowInspectorModal(false)}
          onSave={handleSaveInspectorDraft}
          onRegenerate={handleRegeneratePitch}
          niches={niches}
          pipelines={pipelines}
        />
      )}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Live Sandbox Diagnostics
            </h2>
            <p className="text-sm text-gray-500">
              Test the AI's decision making process in real-time.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="w-64">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Attached Pipeline
            </label>
            <select
              value={activePipelineId || ''}
              onChange={handlePipelineSelect}
              disabled={isRunning || loading}
              className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-base focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
            >
              <option value="" disabled>
                -- Select Pipeline --
              </option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="NEW">+ Create New Pipeline</option>
            </select>
          </div>

          <div className="w-64">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Force Target Niche (Optional)
            </label>
            <select
              value={forceNicheId}
              onChange={(e) => setForceNicheId(e.target.value)}
              disabled={isRunning || loading}
              className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-base focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
            >
              <option value="">-- Let AI Decide --</option>
              {niches.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>

          <div className="w-32">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Max Targets
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={maxTargets}
              onChange={(e) => setMaxTargets(Number(e.target.value))}
              disabled={isRunning || loading}
              className="mt-1 block w-full rounded-md border border-gray-300 py-2 px-3 text-base focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
            />
          </div>

          {!isRunning ? (
            <div className="flex space-x-2">
              <button
                onClick={handleStartClick}
                disabled={loading}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50 h-10"
              >
                {loading
                  ? 'Starting...'
                  : activePipelineId
                    ? 'Start New Sandbox Run'
                    : 'Start New Sandbox Run'}
              </button>
              {sessionId && (status === 'Failed' || status === 'Stopped') && (
                <button
                  onClick={async () => {
                    setLoading(true);
                    try {
                      await fetch('/api/admin/run-crawl', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          resumeSessionId: sessionId,
                          forceNicheId: forceNicheId || undefined,
                          maxTargets,
                          isSandbox: true,
                          pipelineId: activePipelineId,
                        }),
                      });
                    } catch (e) {
                      alert('Failed to resume run');
                    }
                    setLoading(false);
                  }}
                  disabled={loading}
                  className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-500 disabled:opacity-50 h-10"
                >
                  {loading ? 'Resuming...' : '▶️ Resume Failed Run'}
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={handleStopAndSynthesize}
              disabled={synthesizing}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 h-10 disabled:opacity-50"
            >
              {synthesizing
                ? 'AI is reviewing your actions and updating Playbooks...'
                : '⏹️ Stop Sandbox & Synthesize'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-gray-800 bg-gray-900 shadow-sm overflow-hidden flex flex-col h-[600px]">
          <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
            <div className="flex space-x-2"></div>
            <div className="flex gap-4 items-center">
              <button
                onClick={fetchPlaybooks}
                disabled={!activePipelineId}
                className="text-xs text-indigo-300 hover:text-indigo-200 bg-gray-700 px-2 py-1 rounded"
              >
                📚 View Active Playbooks
              </button>
              <span
                className={`text-xs font-mono px-2 py-1 rounded ${
                  status === 'Completed' ||
                  status === '✅ Sandbox Ended. Playbooks successfully updated.'
                    ? 'bg-green-100 text-green-800'
                    : status === 'Failed'
                      ? 'bg-red-100 text-red-800'
                      : status === 'Running' || status === 'Starting...'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-gray-100 text-gray-800'
                }`}
              >
                Status: {status}
              </span>
            </div>
          </div>
          <div
            ref={logsContainerRef}
            onScroll={handleLogsScroll}
            className="p-4 flex-1 overflow-y-auto font-mono text-sm flex flex-col justify-start"
          >
            {agentLogs.length === 0 ? (
              <div className="text-gray-500 italic">Waiting for agents...</div>
            ) : (
              <div className="space-y-3">
                {agentLogs.map((log, i) => {
                  let avatar = '🤖';
                  let name = 'System';
                  let colorClass = 'text-gray-400';

                  switch (log.agentRole) {
                    case 'strategist':
                      avatar = '🧭';
                      name = 'The Strategist';
                      colorClass = 'text-blue-400';
                      break;
                    case 'scraper':
                      avatar = '🕸️';
                      name = 'The Web Scraper';
                      colorClass = 'text-gray-300';
                      break;
                    case 'auditor':
                      avatar = '🕵️';
                      name = 'The Social Auditor';
                      colorClass = 'text-green-400';
                      break;
                    case 'analyst':
                      avatar = '🧠';
                      name = 'Lead Analyst';
                      colorClass = 'text-purple-400';
                      break;
                    case 'copywriter':
                      avatar = '✍️';
                      name = 'The Copywriter';
                      colorClass = 'text-yellow-400';
                      break;
                    case 'system':
                      avatar =
                        log.narrative.toLowerCase().includes('fail') ||
                        log.narrative.toLowerCase().includes('error')
                          ? '❌'
                          : '🤖';
                      name = 'System';
                      colorClass =
                        log.narrative.toLowerCase().includes('fail') ||
                        log.narrative.toLowerCase().includes('error')
                          ? 'text-red-500'
                          : 'text-green-400';
                      break;
                  }

                  return (
                    <div key={i} className="flex space-x-2">
                      <span className="text-lg leading-none">{avatar}</span>
                      <div className="flex-1">
                        <div className={`font-bold ${colorClass}`}>{name}</div>
                        <div
                          className={`${log.agentRole === 'system' ? (log.narrative.toLowerCase().includes('fail') || log.narrative.toLowerCase().includes('error') ? 'text-red-400' : 'text-green-300') : 'text-gray-300'} mt-1`}
                        >
                          {log.narrative}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {isRunning && (
                  <div className="flex space-x-2 items-center text-gray-500 animate-pulse mt-4">
                    <span className="text-lg leading-none">⚙️</span>
                    <div className="text-sm font-semibold">
                      Agent is thinking...
                    </div>
                  </div>
                )}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-gray-50 shadow-sm overflow-hidden flex flex-col h-[600px]">
          <div className="px-4 py-3 bg-white border-b border-gray-200">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-semibold text-gray-900">
                  Sandbox Review Tray
                </h3>
                <p className="text-xs text-gray-500">
                  Select drafted pitches to approve and dispatch
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-between items-center border-b">
              <div className="flex gap-4">
                <button
                  onClick={() => setActiveTab('leads')}
                  className={`pb-2 text-sm font-medium border-b-2 ${activeTab === 'leads' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                >
                  Leads
                </button>
                <button
                  onClick={() => setActiveTab('rejected')}
                  className={`pb-2 text-sm font-medium border-b-2 ${activeTab === 'rejected' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                >
                  Rejected
                </button>
              </div>
              <div className="mb-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="text-xs border-gray-300 rounded focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="All">All Statuses</option>
                  <option value="Qualified">Qualified</option>
                  <option value="incomplete">Incomplete</option>
                  <option value="Failed">Failed</option>
                </select>
              </div>
            </div>
          </div>
          <div className="bg-gray-100 px-4 py-2 flex justify-between items-center border-b border-gray-200">
            <button
              onClick={() => {
                const leadsToDisplay = displayLeads.filter((l) => {
                  const matchesTab =
                    activeTab === 'rejected'
                      ? l.triageStatus === 'rejected' || l.sandboxRejected
                      : l.triageStatus !== 'rejected' && !l.sandboxRejected;
                  const matchesStatus =
                    statusFilter === 'All' || l.status === statusFilter;
                  return matchesTab && matchesStatus;
                });
                const allSelected = leadsToDisplay.every((l) =>
                  selectedLeads.has(l.id)
                );
                const newSet = new Set(selectedLeads);
                if (allSelected) {
                  leadsToDisplay.forEach((l) => newSet.delete(l.id));
                } else {
                  leadsToDisplay.forEach((l) => newSet.add(l.id));
                }
                setSelectedLeads(newSet);
              }}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
            >
              {(() => {
                const leadsToDisplay = displayLeads.filter((l) => {
                  const matchesTab =
                    activeTab === 'rejected'
                      ? l.triageStatus === 'rejected' || l.sandboxRejected
                      : l.triageStatus !== 'rejected' && !l.sandboxRejected;
                  const matchesStatus =
                    statusFilter === 'All' || l.status === statusFilter;
                  return matchesTab && matchesStatus;
                });
                if (leadsToDisplay.length === 0) return 'Select All';
                const allSelected = leadsToDisplay.every((l) =>
                  selectedLeads.has(l.id)
                );
                return allSelected ? 'Deselect All' : 'Select All';
              })()}
            </button>
          </div>
          <div className="p-4 flex-1 overflow-y-auto space-y-4">
            {displayLeads.filter((l) => {
              const matchesTab =
                activeTab === 'rejected'
                  ? l.triageStatus === 'rejected' || l.sandboxRejected
                  : l.triageStatus !== 'rejected' && !l.sandboxRejected;
              const matchesStatus =
                statusFilter === 'All' || l.status === statusFilter;
              return matchesTab && matchesStatus;
            }).length === 0 ? (
              <div className="text-sm text-gray-500 text-center mt-10">
                No leads found matching these filters.
              </div>
            ) : (
              displayLeads
                .filter((l) => {
                  const matchesTab =
                    activeTab === 'rejected'
                      ? l.triageStatus === 'rejected' || l.sandboxRejected
                      : l.triageStatus !== 'rejected' && !l.sandboxRejected;
                  const matchesStatus =
                    statusFilter === 'All' || l.status === statusFilter;
                  return matchesTab && matchesStatus;
                })
                .map((lead) => (
                  <div
                    key={lead.id}
                    className={`bg-white p-4 rounded border shadow-sm space-y-2 relative flex gap-3 ${lead.triageStatus === 'rejected' || lead.sandboxRejected ? 'opacity-50 grayscale' : ''}`}
                  >
                    <div className="pt-1">
                      <input
                        type="checkbox"
                        className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                        checked={selectedLeads.has(lead.id)}
                        onChange={(e) => {
                          const newSet = new Set(selectedLeads);
                          if (e.target.checked) newSet.add(lead.id);
                          else newSet.delete(lead.id);
                          setSelectedLeads(newSet);
                        }}
                      />
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <div className="absolute top-2 right-2 flex gap-2 items-center">
                        {!lead.whatsappNumber && (
                          <span className="bg-yellow-100 text-yellow-800 text-xs px-2 py-1 rounded font-semibold">
                            Missing Contact Info
                          </span>
                        )}
                        {lead.triageStatus === 'approved' && (
                          <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded font-semibold">
                            Approved
                          </span>
                        )}
                        {(lead.triageStatus === 'rejected' ||
                          lead.sandboxRejected) && (
                          <span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded font-semibold">
                            Rejected
                          </span>
                        )}
                        <span className="bg-indigo-100 text-indigo-800 text-xs px-2 py-1 rounded font-semibold">
                          Score: {lead.socialMediaGapScore}/10
                        </span>
                      </div>
                      <h4 className="font-bold text-gray-900 truncate pr-24">
                        {lead.brandName}
                      </h4>
                      <p className="text-xs text-gray-500">{lead.websiteUrl}</p>
                      <div className="mt-2 bg-gray-100 p-3 rounded text-sm text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto relative">
                        <span className="font-semibold block mb-1">
                          ✍️ Pitch Draft ({lead.pitchAngle}):
                        </span>
                        {lead.generatedPitch}
                        <div className="absolute top-2 right-2 flex gap-2">
                          <button
                            onClick={() => openInspector(lead)}
                            className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded hover:bg-indigo-200"
                          >
                            🔍 Inspect & Triage
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
            )}
          </div>
          <div className="px-4 py-3 bg-white border-t border-gray-200">
            <button
              onClick={handleFinalizeSandbox}
              disabled={dispatching || displayLeads.length === 0}
              className="w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {dispatching
                ? 'Finalizing Session...'
                : `Finalize Session & Dispatch`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
