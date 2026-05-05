import type { ConnectorToolName } from "../../../../packages/connector/src/index.js";
import type { ToolError } from "../../../../packages/core/src/index.js";

type ToolResponse<T> = ({ ok: true } & T) | ToolError;
export type WebgptConversationMode = "resume" | "new";
export type AuthorProvider = "webgpt" | "gemma4_local";
type AuthorOptions = { conversationMode?: WebgptConversationMode; provider?: AuthorProvider };

export class ConnectorError extends Error {
  readonly code: string;
  readonly fieldErrors?: ToolError["fieldErrors"];

  constructor(error: ToolError) {
    super(error.message);
    this.code = error.code;
    this.fieldErrors = error.fieldErrors;
  }
}

export async function callTool<T>(toolName: ConnectorToolName, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/api/connector/call", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ toolName, args })
  });

  const body = (await response.json()) as ToolResponse<T>;
  if (!body.ok) {
    throw new ConnectorError(body);
  }
  const { ok: _ok, ...result } = body;
  return result as T;
}

function providerBody(provider: AuthorProvider | undefined): { provider?: AuthorProvider } {
  return provider && provider !== "webgpt" ? { provider } : {};
}

export async function startWebgptAuthor(worldId: string, sessionId: string, options: AuthorOptions = {}): Promise<{ dispatchId?: string; provider?: AuthorProvider }> {
  const response = await fetch("/api/webgpt/author-once", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ worldId, sessionId, conversationMode: options.conversationMode ?? "resume", ...providerBody(options.provider) })
  });
  const body = (await response.json()) as { ok?: boolean; message?: string; dispatchId?: string; provider?: AuthorProvider };
  if (!response.ok || body.ok === false) {
    throw new Error(body.message ?? "작성 작업을 시작하지 못했습니다.");
  }
  return body.dispatchId ? { dispatchId: body.dispatchId, ...(body.provider ? { provider: body.provider } : {}) } : {};
}

export async function startWebgptCgLane(
  worldId: string,
  sessionId: string,
  maxJobs = 2,
  options: { conversationMode?: WebgptConversationMode } = {}
): Promise<{ started: boolean; maxJobs: number }> {
  const response = await fetch("/api/webgpt/cg-run", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ worldId, sessionId, maxJobs, conversationMode: options.conversationMode ?? "resume" })
  });
  const body = (await response.json()) as { ok?: boolean; message?: string; started?: boolean; maxJobs?: number };
  if (!response.ok || body.ok === false) {
    throw new Error(body.message ?? "CG WebGPT 작업을 시작하지 못했습니다.");
  }
  return { started: Boolean(body.started), maxJobs: body.maxJobs ?? maxJobs };
}

export async function recordActionAndStartWebgpt(input: {
  worldId: string;
  sessionId: string;
  turnId: string;
  kind: "choice" | "freeform";
  label?: string | null;
  text: string;
  conversationMode?: WebgptConversationMode;
  provider?: AuthorProvider;
}): Promise<{ playerActionId: string; dispatchId: string; provider?: AuthorProvider; timings?: Record<string, string> }> {
  const { provider, ...payload } = input;
  const response = await fetch("/api/webgpt/record-action-and-author", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ ...payload, ...providerBody(provider) })
  });
  const body = (await response.json()) as {
    ok?: boolean;
    message?: string;
    playerActionId?: string;
    dispatchId?: string;
    provider?: AuthorProvider;
    timings?: Record<string, string>;
  };
  if (!response.ok || body.ok === false || !body.playerActionId || !body.dispatchId) {
    throw new Error(body.message ?? "선택을 작성 lane에 전달하지 못했습니다.");
  }
  return {
    playerActionId: body.playerActionId,
    dispatchId: body.dispatchId,
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.timings ? { timings: body.timings } : {})
  };
}
