// Shapes for the outbound chat-detail view (conversation + activities). Copied
// faithfully from the E2E test client so this view renders identical data.

export interface ChatMessage {
  id: string;
  timestamp: string | null;
  type: string;
  direction: string | null;
  sender: { kind?: string } | null;
  content: Record<string, any> | null;
  status: string | null;
  source: string | null;
  attachments: any[];
}

export interface ChatTask {
  id: string;
  type: string | null;
  executed: boolean;
  permanent_failure?: boolean;
  execute_at: string | null;
  created_at: string | null;
  instructions: string | null;
  taskData: any;
  output: any;
}

export interface ChatData {
  messages: ChatMessage[];
  tasks: ChatTask[];
  activities: Record<string, any>[];
  notifications: Record<string, any>[];
  chatFields: Record<string, any>;
}

// Unified Activities feed item: a tool-call activity or a non-scheduled task.
export type FeedItem =
  | { kind: 'activity'; ts: number; id: string; data: Record<string, any> }
  | { kind: 'task'; ts: number; id: string; data: ChatTask };
