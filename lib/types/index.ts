import type { Timestamp } from 'firebase-admin/firestore';

export interface Pipeline {
  id: string;
  userId: string;
  name: string;
  description?: string;
  clientSeedUrls?: string[];
  status: 'running' | 'paused' | 'stopped';
  connectionId: string | null;
  settings: {
    overrideGlobalDeduplication: boolean;
    // can add other settings here, or keep guardrails
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Niche {
  id: string;
  userId: string;
  pipelineId: string;
  nicheName: string;
  crawlPriority: number;
  avgGapScore: number;
  closeRate: number;
  avgProductPrice: number;
  seedUrls: string[];
  blacklistedSignals: string[];
  aiReasoning?: string;
  marketHypothesis?: string;
  confidenceScore?: number;
  researchCitations?: string[];
  pipelineGuardrails?: {
    maxDailyCrawls: number;
    maxDailyDispatches: number;
    minAiGapScore: number;
  };
  // Niche health tracking (optional for backwards-compat; createNiche always sets them)
  health_score?: number; // 0–100; starts at 100, drops 33 pts per failing session
  consecutive_failures?: number; // incremented each session where qualified/total < 5%
  status?: 'active' | 'cool-down';
  coolDownReason?: string | null;
  replacedNicheId?: string | null; // set on replacement niches only
  replacedNicheName?: string | null;
  lastCrawled: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Lead {
  id: string;
  userId: string;
  pipelineId: string;
  nicheId: string;
  crawlSessionId: string | null;
  brandName: string;
  websiteUrl: string;
  whatsappNumber: string;
  instagramUrl: string | null;
  targetProductName: string | null;
  targetProductImageUrl: string | null;
  generatedPitch: string | null;
  pitchAngle: 'noVideo' | 'badVideo' | 'costPain' | 'volumeHungry' | null;
  crawlSource: string;
  dedupHash: string;
  socialMediaGapScore: number;
  status:
    | 'Qualified'
    | 'Pitched'
    | 'Failed'
    | 'incomplete'
    | 'Closed'
    | 'Rejected'
    | 'Ghosted'
    | 'Negotiating'
    | 'approved';
  isSandbox?: boolean;
  dispatchStatus?: 'pending_approval' | 'approved';
  sandboxRejected?: boolean;
  sandboxRejectionReason?: string | null;
  originalGeneratedPitch?: string;
  // Populated by dispatcher after sending
  lastMessageSent?: string | null;
  lastMessageSentAt?: Timestamp | null;
  dispatchSuccess?: boolean | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  analystNarrative?: string | null;
}

export interface PitchEvaluation {
  id: string;
  userId: string;
  leadId: string;
  gapScore: number;
  pitchAngle: 'noVideo' | 'badVideo' | 'costPain' | 'volumeHungry';
  sanitizedImages: string[];
  websiteTextSummary: string;
  igPostSummary: string;
  rawGeminiResponse: string;
  createdAt: Timestamp;
}

export interface AgentLog {
  timestamp: string;
  agentRole:
    | 'strategist'
    | 'scraper'
    | 'auditor'
    | 'analyst'
    | 'copywriter'
    | 'system';
  narrative: string;
}

export interface CrawlSession {
  id: string;
  userId: string;
  pipelineId: string;
  nicheId: string;
  targetUrls: string[];
  discoveredBrands: string[];
  processedBrands?: string[];
  leadsCreated: number;
  leadsQualified: number;
  agentReasoning: string;
  sessionStatus: 'Running' | 'Completed' | 'Failed' | 'Stopped';
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  agentLogs?: AgentLog[];
  isSandbox?: boolean;
}

export interface DispatchLog {
  id: string;
  userId: string;
  leadId: string;
  whatsappNumber: string;
  messageSent: string;
  success: boolean;
  errorMessage: string | null;
  attemptNumber: number;
  dispatchedAt: Timestamp;
}

export interface UserProfile {
  id?: string;
  email: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemSettings {
  id: string; // usually 'default'
  userId: string;
  crawlEnabled: boolean;
  dispatchEnabled: boolean;
  maxConcurrentPipelines: number;
  dispatchBatchSize: number;
  crawlScheduleHour: number; // 0-23 UTC
  dispatchScheduleHour: number; // 0-23 UTC
  // When true, the server's environment variables are used for all
  // integrations instead of the keys entered below.
  useEnvKeys?: boolean;
  apiKeys?: {
    openAi?: string;
    gemini?: string;
    firecrawl?: string;
    unipile?: string;
  };
  updatedAt: Timestamp;
}

export interface Connection {
  id: string;
  userId: string;
  provider: 'whatsapp';
  phoneNumber: string;
  countryCode: string;
  status: 'connected' | 'disconnected';
  webhookUrl: string | null;
  instanceId: string | null;
  apiKey: string | null;
  connectedAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FeedbackSignal {
  id: string;
  userId: string;
  pipelineId: string;
  leadId: string;
  nicheId: string;
  outcome: 'Closed' | 'Rejected' | 'Ghosted' | 'Negotiating';
  pitchAngleUsed: 'noVideo' | 'badVideo' | 'costPain' | 'volumeHungry';
  productPrice: number;
  gapScoreAtPitch: number;
  notes: string | null;
  aiAdjustmentLog?: string;
  recordedAt: Timestamp;
}

export interface IntelligenceRegistry {
  id: string;
  userId: string;
  pipelineId: string; // Typically map to a nicheId or an overall setting ID
  agentRole: 'strategist' | 'scraper' | 'auditor' | 'analyst' | 'copywriter';
  blobUrl: string;
  version: number;
  lastUpdated: Timestamp;
}
