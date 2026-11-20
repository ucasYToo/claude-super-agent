export interface Scope {
  workspaceId: string;
  ownerId: string;
}

export type Target =
  | { kind: "feishu"; botId: string; appId: string; chatId: string }
  | { kind: "local"; clientId: string };

export interface Route {
  scope: Scope;
  target: Target;
  conversationKey: string;
}

export interface ImageInput {
  type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: Buffer;
}

export interface Inbound extends Route {
  messageId: string;
  text: string;
  image?: ImageInput;
}

export type JobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";

export interface WorkerConfig {
  name: string;
  purpose: string;
  model?: string;
  cwd?: string;
  instructions?: string;
  tools?: string[];
}

export interface Workspace {
  id: string;
  cwd: string;
  allowedCwds?: string[];
  model?: string;
  auxiliaryModel?: string;
  visionModel?: string;
  workers?: WorkerConfig[];
  timezone?: string;
  consolidateAt?: string;
  turnTimeoutMinutes?: number;
  excludeParentRules?: boolean;
  claudeOptions?: string[];
}

export interface Bot {
  enabled?: boolean;
  id: string;
  appId: string;
  appSecretEnv?: string;
  appSecret?: string;
  workspaceId: string;
  allowedOpenIds: string[];
}

export interface Config {
  workspaces: Workspace[];
  feishu?: { bots: Bot[] };
  claudeCommand?: string;
  activeWorkspace?: string;
}

export interface Delivery {
  id: string;
  route: Route;
  text: string;
  kind: "text" | "card";
  cardId?: string;
  jobId?: number;
}

export type Deliver = (item: Delivery) => Promise<string | void>;

export interface RunInput {
  role: "main" | "worker" | "summary" | "memory";
  cwd: string;
  prompt: string;
  system: string;
  tools: string[];
  model?: string;
  sessionId?: string;
  image?: ImageInput;
  signal: AbortSignal;
  excludeParentRules?: boolean;
  claudeOptions?: string[];
  mcpConfig?: object;
  onProcess?: (pid: number) => void;
  onProgress?: (event: string) => void;
  onSession?: (id: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
}

export interface Options {
  dataDir: string;
  workspaces?: Workspace[];
  resolveWorkspace?: (id: string) => Workspace | undefined;
  deliver?: Deliver;
  runner?: (input: RunInput) => Promise<RunResult>;
  claudeCommand?: string;
  now?: () => number;
  tickMs?: number;
}

export const scopeKey = (scope: Scope) => JSON.stringify([scope.workspaceId, scope.ownerId]);
export const threadKey = (route: Route) =>
  JSON.stringify([route.scope.workspaceId, route.scope.ownerId, route.conversationKey]);
export const localRoute = (workspaceId: string): Route => ({
  scope: { workspaceId, ownerId: "local" },
  target: { kind: "local", clientId: "console" },
  conversationKey: "console",
});

export function required(value: unknown, name: string, max = 16000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw Error("无效的 " + name);
  }
  return value.trim();
}
