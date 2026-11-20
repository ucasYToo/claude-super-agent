import type { JobStatus } from "../agent/contracts";

interface ConversationRecord {
  id: number;
  workspace: string;
  scope: string;
  thread: string;
  generation: number;
  route: string;
  depth: number;
  created: number;
}

export interface TurnRecord extends ConversationRecord {
  source: string;
  text: string;
  has_image: number;
  job: number | null;
}

export interface JobRecord extends ConversationRecord {
  title: string;
  prompt: string;
  worker: string;
  parent: number | null;
  continued: number | null;
  session: string | null;
  state: JobStatus;
  eta: number;
  started: number | null;
  ended: number | null;
  result: string;
  progress: string;
}
