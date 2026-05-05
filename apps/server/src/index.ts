import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openDatabase } from "./db.js";
import { createConnectorTools } from "./connectorTools.js";
import { createRepository } from "./repository.js";
import {
  buildWebGptManifest,
  buildWebGptOpenApi,
  connectorToolNames,
  isJsonRpcNotification,
  isJsonRpcRequest,
  jsonRpcError,
  jsonRpcResult,
  mcpContentResult,
  mcpInitializeResult,
  mcpRequestParams,
  mcpToolsListResult,
  type ConnectorToolName
} from "../../../packages/connector/src/index.js";
import type { ToolResult, WebgptDispatchRecord } from "../../../packages/core/src/index.js";

function loadLocalEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

loadLocalEnv();

const port = Number(process.env.VNPLAYER_PORT ?? 4174);
const repository = createRepository(openDatabase());
const projectRoot = process.cwd();
const publicMcpToolNames = [
  "vn_receive_visible_turn_v2",
  "vn_get_library_outline",
  "vn_get_library_docs"
] satisfies ConnectorToolName[];

const publicDispatchScopedToolNames = new Set<ConnectorToolName>(publicMcpToolNames);
const mcpAuditLogPath = resolve(projectRoot, "data", "mcp-audit.jsonl");

type TurnEvent = {
  type: "turn_submitted";
  worldId: string;
  sessionId: string;
  turnId: string;
  at: string;
};

type WebgptDispatchEvent = {
  type: "webgpt_dispatch_changed";
  worldId: string;
  sessionId: string;
  dispatchId: string;
  status: string;
  at: string;
};

type CgLaneEvent = {
  type: "cg_lane_changed";
  worldId: string;
  sessionId: string;
  status: "started" | "updated" | "finished" | "failed";
  at: string;
};

type WebgptConversationMode = "resume" | "new";
type AuthorProvider = "webgpt" | "gemma4_local";

type EventClient = {
  id: number;
  worldId: string;
  sessionId: string;
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
};

type McpSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

let nextEventClientId = 1;
const eventClients = new Map<number, EventClient>();
const mcpSessions = new Map<string, McpSession>();

function sendSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function publishTurnSubmitted(event: Omit<TurnEvent, "type" | "at">): void {
  const payload: TurnEvent = { type: "turn_submitted", ...event, at: new Date().toISOString() };
  for (const client of eventClients.values()) {
    if (client.worldId === payload.worldId && client.sessionId === payload.sessionId) {
      sendSse(client.response, payload.type, payload);
    }
  }
}

function publishWebgptDispatchChanged(event: Omit<WebgptDispatchEvent, "type" | "at">): void {
  const payload: WebgptDispatchEvent = { type: "webgpt_dispatch_changed", ...event, at: new Date().toISOString() };
  for (const client of eventClients.values()) {
    if (client.worldId === payload.worldId && client.sessionId === payload.sessionId) {
      sendSse(client.response, payload.type, payload);
    }
  }
}

function publishCgLaneChanged(event: Omit<CgLaneEvent, "type" | "at">): void {
  const payload: CgLaneEvent = { type: "cg_lane_changed", ...event, at: new Date().toISOString() };
  for (const client of eventClients.values()) {
    if (client.worldId === payload.worldId && client.sessionId === payload.sessionId) {
      sendSse(client.response, payload.type, payload);
    }
  }
}

const connectorTools = createConnectorTools(repository, {
  onTurnSubmitted: publishTurnSubmitted,
  onCgChanged: (event) => {
    publishCgLaneChanged({ worldId: event.worldId, sessionId: event.sessionId, status: "updated" });
  }
});

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "accept,authorization,content-type,mcp-protocol-version,mcp-session-id",
    "access-control-expose-headers": "mcp-session-id"
  });
  response.end(JSON.stringify(body));
}

function mcpSessionIdFrom(request: IncomingMessage): string | null {
  const raw = request.headers["mcp-session-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || null;
}

function touchMcpSession(sessionId: string): void {
  const now = new Date().toISOString();
  const existing = mcpSessions.get(sessionId);
  mcpSessions.set(sessionId, { id: sessionId, createdAt: existing?.createdAt ?? now, updatedAt: now });
}

function createMcpSession(): string {
  const sessionId = `vnplayer-${randomUUID()}`;
  touchMcpSession(sessionId);
  return sessionId;
}

function mcpHeaders(sessionId?: string): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "accept,authorization,content-type,mcp-protocol-version,mcp-session-id",
    "access-control-expose-headers": "mcp-session-id",
    ...(sessionId ? { "mcp-session-id": sessionId } : {})
  };
}

function readBody(request: IncomingMessage, maxBytes = 128_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("요청 본문이 너무 큽니다."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("요청 본문은 JSON이어야 합니다."));
      }
    });
    request.on("error", reject);
  });
}

const cgAssetDir = resolve(projectRoot, "data", "cg-assets");
const cgAssetMaxBytes = Number(process.env.VNPLAYER_CG_ASSET_MAX_BYTES ?? 20 * 1024 * 1024);
const cgAssetMinDimension = Number(process.env.VNPLAYER_CG_ASSET_MIN_DIMENSION ?? 64);
const cgAssetMimeToExt = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

type ImageDimensions = {
  width: number;
  height: number;
};

function extensionForImageMime(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = cgAssetMimeToExt.get(normalized);
  if (!ext) {
    throw new Error(`지원하지 않는 이미지 MIME입니다: ${mimeType}`);
  }
  return ext;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function imageDimensionsFromBytes(bytes: Uint8Array, mimeType: string): ImageDimensions | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/png") {
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
      return null;
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (normalized === "image/gif") {
    if (buffer.length < 10 || !buffer.toString("ascii", 0, 3).startsWith("GIF")) {
      return null;
    }
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (normalized === "image/jpeg") {
    let offset = 2;
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return null;
    }
    while (offset + 9 < buffer.length) {
      while (buffer[offset] === 0xff) {
        offset += 1;
      }
      const marker = buffer[offset];
      offset += 1;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        return null;
      }
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += segmentLength;
    }
    return null;
  }
  if (normalized === "image/webp") {
    if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
      return null;
    }
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const b1 = buffer[21] ?? 0;
      const b2 = buffer[22] ?? 0;
      const b3 = buffer[23] ?? 0;
      const b4 = buffer[24] ?? 0;
      return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

function assertImportableCgAsset(bytes: Uint8Array, mimeType: string): ImageDimensions {
  const dimensions = imageDimensionsFromBytes(bytes, mimeType);
  if (!dimensions) {
    throw new Error("이미지 크기를 읽지 못했습니다. 원본 이미지 파일을 다시 첨부해야 합니다.");
  }
  if (dimensions.width < cgAssetMinDimension || dimensions.height < cgAssetMinDimension) {
    throw new Error(`이미지 크기가 너무 작습니다: ${dimensions.width}x${dimensions.height}`);
  }
  return dimensions;
}

function storeCgAssetBytes(input: { bytes: Uint8Array; mimeType: string; baseUrl: string }): { assetUrl: string; sha256: string; bytes: number; width: number; height: number } {
  if (input.bytes.byteLength <= 0) {
    throw new Error("이미지 데이터가 비어 있습니다.");
  }
  if (input.bytes.byteLength > cgAssetMaxBytes) {
    throw new Error(`이미지 데이터가 너무 큽니다: ${input.bytes.byteLength} bytes`);
  }
  const ext = extensionForImageMime(input.mimeType);
  const dimensions = assertImportableCgAsset(input.bytes, input.mimeType);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const filename = `${sha256}.${ext}`;
  mkdirSync(cgAssetDir, { recursive: true });
  writeFileSync(join(cgAssetDir, filename), input.bytes);
  return {
    assetUrl: `${input.baseUrl}/api/cg-assets/${filename}`,
    sha256,
    bytes: input.bytes.byteLength,
    width: dimensions.width,
    height: dimensions.height
  };
}

async function importCgAssetImage(args: Record<string, unknown>, baseUrl: string): Promise<{ assetUrl: string; sha256: string; bytes: number; width: number; height: number; mimeType: string }> {
  const dataUrl = typeof args.dataUrl === "string" ? args.dataUrl.trim() : "";
  const imageUrl = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
  if (dataUrl) {
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match?.[1] || !match[2]) {
      throw new Error("dataUrl은 base64 이미지 data URL이어야 합니다.");
    }
    const bytes = Buffer.from(match[2], "base64");
    return { ...storeCgAssetBytes({ bytes, mimeType: match[1], baseUrl }), mimeType: match[1] };
  }
  if (!imageUrl) {
    throw new Error("imageUrl 또는 dataUrl이 필요합니다.");
  }
  const parsed = new URL(imageUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("imageUrl은 http/https URL이어야 합니다.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const fetched = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
    if (!fetched.ok) {
      throw new Error(`이미지를 가져오지 못했습니다: ${fetched.status}`);
    }
    const mimeType = fetched.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    extensionForImageMime(mimeType);
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    return { ...storeCgAssetBytes({ bytes, mimeType, baseUrl }), mimeType };
  } finally {
    clearTimeout(timeout);
  }
}

function serveCgAsset(response: ServerResponse, pathname: string): boolean {
  const filename = basename(decodeURIComponent(pathname.slice("/api/cg-assets/".length)));
  if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(filename)) {
    return false;
  }
  const filePath = join(cgAssetDir, filename);
  if (!existsSync(filePath)) {
    return false;
  }
  const ext = filename.split(".").pop();
  const mimeType = ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/gif";
  response.writeHead(200, {
    "content-type": mimeType,
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*"
  });
  response.end(readFileSync(filePath));
  return true;
}

function auditMcp(request: IncomingMessage, body: unknown, extra: Record<string, unknown> = {}): void {
  try {
    mkdirSync(resolve(projectRoot, "data"), { recursive: true });
    const rpc = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const params = typeof rpc.params === "object" && rpc.params !== null && !Array.isArray(rpc.params) ? (rpc.params as Record<string, unknown>) : {};
    appendFileSync(
      mcpAuditLogPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: request.method,
        url: request.url,
        external: isExternalConnectorRequest(request),
        sessionId: mcpSessionIdFrom(request),
        rpcMethod: rpc.method,
        rpcId: rpc.id,
        toolName: params.name,
        hasArguments: typeof params.arguments === "object" && params.arguments !== null,
        ...extra
      })}\n`
    );
  } catch {
    // Audit is diagnostic only. The connector must keep serving requests if logging fails.
  }
}

function isConnectorToolName(value: unknown): value is ConnectorToolName {
  return typeof value === "string" && connectorToolNames.includes(value as ConnectorToolName);
}

function connectorBaseUrl(request: IncomingMessage): string {
  const externalHost = request.headers["x-vnplayer-external-host"];
  const hostHeader = Array.isArray(externalHost) ? externalHost[0] : externalHost;
  const host = hostHeader?.trim() || request.headers.host || `127.0.0.1:${port}`;
  const externalProtocol = request.headers["x-vnplayer-external-proto"];
  const protocol = externalProtocol || request.headers["x-forwarded-proto"] || "http";
  const firstProtocol = Array.isArray(protocol) ? protocol[0] : protocol.split(",")[0]?.trim();
  return `${firstProtocol || "http"}://${host}`;
}

function isExternalConnectorRequest(request: IncomingMessage): boolean {
  const externalHost = request.headers["x-vnplayer-external-host"];
  return Boolean((Array.isArray(externalHost) ? externalHost[0] : externalHost)?.trim());
}

function mcpAllowedToolNames(request: IncomingMessage): readonly ConnectorToolName[] {
  return isExternalConnectorRequest(request) ? publicMcpToolNames : connectorTools.names;
}

function toolAllowedForRequest(request: IncomingMessage, toolName: ConnectorToolName): boolean {
  return mcpAllowedToolNames(request).includes(toolName);
}

function publicConnectorBaseUrl(request: IncomingMessage): string {
  const externalHost = request.headers["x-vnplayer-external-host"];
  const hasExternalHost = Boolean((Array.isArray(externalHost) ? externalHost[0] : externalHost)?.trim());
  if (!hasExternalHost) {
    const frontdoor = process.env.VNPLAYER_FRONTDOOR_URL?.trim().replace(/\/$/, "");
    if (frontdoor) {
      return frontdoor;
    }
  }
  return connectorBaseUrl(request);
}

function activeWebgptJobsKey(worldId: string, sessionId: string): string {
  return `${worldId}\n${sessionId}`;
}

const activeWebgptJobs = new Set<string>();
const activeCgLaneJobs = new Set<string>();

function hashDispatchToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function stringArg(args: unknown, key: string): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("도구 인자는 객체여야 합니다.");
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} 값이 필요합니다.`);
  }
  return value.trim();
}

function optionalStringArg(args: unknown, key: string): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("도구 인자는 객체여야 합니다.");
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function conversationModeArg(value: unknown): WebgptConversationMode {
  return value === "new" || value === "rollover" ? "new" : "resume";
}

function authorProviderArg(value: unknown): AuthorProvider {
  const rawValue = typeof value === "string" && value.trim() ? value.trim() : process.env.VNPLAYER_TEXT_AUTHOR_PROVIDER ?? "webgpt";
  const normalized = rawValue.toLowerCase().replace(/[-\s]/g, "_");
  switch (normalized) {
    case "webgpt":
      return "webgpt";
    case "gemma":
    case "gemma4":
    case "gemma_4":
    case "gemma4_local":
    case "gemma4_llamacpp":
    case "llama_cpp":
    case "llamacpp":
    case "local_gemma":
    case "local_llm":
      return "gemma4_local";
    default:
      throw new Error(`지원하지 않는 작성 provider입니다: ${rawValue}`);
  }
}

function authorProviderLabel(provider: AuthorProvider): string {
  return provider === "gemma4_local" ? "Gemma4 llama.cpp" : "WebGPT";
}

function verifyPublicToolAccess(toolName: ConnectorToolName, args: unknown): WebgptDispatchRecord | null {
  if (!publicDispatchScopedToolNames.has(toolName)) {
    return null;
  }
  const worldId = stringArg(args, "worldId");
  const sessionId = stringArg(args, "sessionId");
  const dispatchToken = optionalStringArg(args, "dispatchToken");
  if (!dispatchToken) {
    const activeDispatch = repository.activeWebgptDispatch(worldId, sessionId);
    if (!activeDispatch) {
      throw new Error("활성 WebGPT 작업이 없어서 공개 턴 제출을 받을 수 없습니다.");
    }
    return activeDispatch;
  }
  return repository.verifyWebgptDispatchToken({
    worldId,
    sessionId,
    dispatchTokenHash: hashDispatchToken(dispatchToken)
  });
}

function hasTurnLibraryUpdates(args: unknown): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const turn = (args as Record<string, unknown>).turn;
  if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
    return false;
  }
  const updates = (turn as Record<string, unknown>).libraryUpdates;
  return Array.isArray(updates) && updates.length > 0;
}

function hasInlineLibraryUpdateMarker(args: unknown): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const turn = (args as Record<string, unknown>).turn;
  if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
    return false;
  }
  const scene = (turn as Record<string, unknown>).scene;
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
    return false;
  }
  const paragraphs = (scene as Record<string, unknown>).paragraphs;
  if (typeof paragraphs === "string") {
    return paragraphs.includes("LIBRARY_UPDATE_JSON:");
  }
  return Array.isArray(paragraphs) && paragraphs.some((paragraph) => typeof paragraph === "string" && paragraph.includes("LIBRARY_UPDATE_JSON:"));
}

function publicReceiveHasAuthoredLibraryContext(toolName: ConnectorToolName, args: unknown, dispatch: WebgptDispatchRecord | null): boolean {
  if (toolName !== "vn_receive_visible_turn" && toolName !== "vn_receive_visible_turn_v2") {
    return true;
  }
  if (hasTurnLibraryUpdates(args)) {
    return true;
  }
  if (hasInlineLibraryUpdateMarker(args)) {
    return true;
  }
  if (!dispatch) {
    return false;
  }
  return repository.countLibraryVersionsCreatedSince({
    worldId: dispatch.worldId,
    since: dispatch.createdAt
  }) > 0;
}

function closeDispatchAfterPublicReceive(
  toolName: ConnectorToolName,
  dispatch: WebgptDispatchRecord | null,
  result: ToolResult<Record<string, unknown>>
): WebgptDispatchRecord | null {
  if ((toolName !== "vn_receive_visible_turn" && toolName !== "vn_receive_visible_turn_v2") || !dispatch || !result.ok) {
    return null;
  }
  const closed = repository.finishWebgptDispatch({
    id: dispatch.id,
    status: "succeeded",
    result: {
      turnId: result.turnId,
      completedBy: toolName
    },
    errorMessage: null
  });
  publishWebgptDispatchChanged({
    worldId: closed.worldId,
    sessionId: closed.sessionId,
    dispatchId: closed.id,
    status: closed.status
  });
  return closed;
}

function startTextAuthorJob(input: {
  worldId: string;
  sessionId: string;
  baseUrl: string;
  provider?: AuthorProvider;
  conversationMode?: WebgptConversationMode;
  trigger?: Record<string, unknown>;
  serverTimings?: Record<string, string>;
}): { started: true; dispatchId: string; provider: AuthorProvider } {
  const provider = input.provider ?? authorProviderArg(null);
  const providerLabel = authorProviderLabel(provider);
  const key = activeWebgptJobsKey(input.worldId, input.sessionId);
  if (activeWebgptJobs.has(key)) {
    const activeDispatch = repository.activeWebgptDispatch(input.worldId, input.sessionId);
    if (activeDispatch) {
      throw new Error("이미 이 세션의 작성 작업이 진행 중입니다.");
    }
    activeWebgptJobs.delete(key);
  }
  const dispatchCreatedAt = new Date().toISOString();
  const dispatchId = `dispatch_${dispatchCreatedAt.replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const dispatchToken = randomBytes(24).toString("base64url");
  const conversationMode = input.conversationMode ?? "resume";
  const dispatch = repository.createWebgptDispatch({
    id: dispatchId,
    worldId: input.worldId,
    sessionId: input.sessionId,
    dispatchTokenHash: hashDispatchToken(dispatchToken),
    payload: {
      provider,
      baseUrl: input.baseUrl,
      conversationMode,
      promptMode: provider === "gemma4_local" ? "gemma-stateless-current" : "webgpt-chat-session",
      startedBy: "vnplayer-server",
      trigger: input.trigger ?? null,
      serverTimings: {
        dispatchCreatedAt,
        ...input.serverTimings
      }
    }
  });
  publishWebgptDispatchChanged({
    worldId: dispatch.worldId,
    sessionId: dispatch.sessionId,
    dispatchId: dispatch.id,
    status: dispatch.status
  });
  activeWebgptJobs.add(key);
  const scriptPath = resolve(projectRoot, "scripts", provider === "gemma4_local" ? "gemma-author-once.mjs" : "webgpt-author-once.mjs");
  const commonArgs = [
    scriptPath,
    "--world-id",
    input.worldId,
    "--session-id",
    input.sessionId,
    "--local-base-url",
    `http://127.0.0.1:${port}`,
    "--dispatch-id",
    dispatchId,
    "--dispatch-token",
    dispatchToken
  ];
  const providerArgs =
    provider === "webgpt"
      ? [
          "--base-url",
          input.baseUrl,
          "--conversation-mode",
          conversationMode
        ]
      : [];
  const child = spawn(
    process.execPath,
    [...commonArgs, ...providerArgs],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: "ignore",
      detached: true
    }
  );
  child.once("exit", () => {
    activeWebgptJobs.delete(key);
    const latest = repository.latestWebgptDispatch(input.worldId, input.sessionId);
    if (latest?.id === dispatchId && latest.status === "running") {
      const failedDispatch = repository.finishWebgptDispatch({
        id: dispatchId,
        status: "failed",
        errorMessage: `${providerLabel} 작성 작업이 완료 상태를 남기지 않고 종료되었습니다.`
      });
      publishWebgptDispatchChanged({
        worldId: failedDispatch.worldId,
        sessionId: failedDispatch.sessionId,
        dispatchId: failedDispatch.id,
        status: failedDispatch.status
      });
    }
  });
  child.once("error", (error) => {
    activeWebgptJobs.delete(key);
    const failedDispatch = repository.finishWebgptDispatch({
      id: dispatchId,
      status: "failed",
      errorMessage: error.message
    });
    publishWebgptDispatchChanged({
      worldId: failedDispatch.worldId,
      sessionId: failedDispatch.sessionId,
      dispatchId: failedDispatch.id,
      status: failedDispatch.status
    });
  });
  child.unref();
  return { started: true, dispatchId, provider };
}

function startCgLaneJob(input: {
  worldId: string;
  sessionId: string;
  maxJobs: number;
  conversationMode?: WebgptConversationMode;
}): { started: boolean; maxJobs: number } {
  repository.getReaderState(input.worldId, input.sessionId);
  const key = activeWebgptJobsKey(input.worldId, input.sessionId);
  if (activeCgLaneJobs.has(key)) {
    return { started: false, maxJobs: input.maxJobs };
  }
  activeCgLaneJobs.add(key);
  publishCgLaneChanged({ worldId: input.worldId, sessionId: input.sessionId, status: "started" });
  const child = spawn(
    process.execPath,
    [
      resolve(projectRoot, "scripts", "webgpt-cg-worker.mjs"),
      "--max-jobs",
      String(input.maxJobs),
      "--continue-on-error",
      "--local-base-url",
      `http://127.0.0.1:${port}`,
      "--world-id",
      input.worldId,
      "--session-id",
      input.sessionId,
      "--conversation-mode",
      input.conversationMode ?? "resume"
    ],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: "ignore",
      detached: true
    }
  );
  child.once("exit", (code) => {
    activeCgLaneJobs.delete(key);
    publishCgLaneChanged({
      worldId: input.worldId,
      sessionId: input.sessionId,
      status: code === 0 ? "finished" : "failed"
    });
  });
  child.once("error", () => {
    activeCgLaneJobs.delete(key);
    publishCgLaneChanged({ worldId: input.worldId, sessionId: input.sessionId, status: "failed" });
  });
  child.unref();
  return { started: true, maxJobs: input.maxJobs };
}

function objectArgs(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("요청 본문은 객체여야 합니다.");
  }
  return body as Record<string, unknown>;
}

function handleEventStream(request: IncomingMessage, response: ServerResponse, url: URL): void {
  const worldId = url.searchParams.get("worldId")?.trim();
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!worldId || !sessionId) {
    sendJson(response, 400, { ok: false, code: "bad_request", message: "worldId와 sessionId가 필요합니다." });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });
  response.write(": connected\n\n");

  const id = nextEventClientId;
  nextEventClientId += 1;
  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 25_000);

  eventClients.set(id, { id, worldId, sessionId, response, heartbeat });

  request.on("close", () => {
    const client = eventClients.get(id);
    if (client) {
      clearInterval(client.heartbeat);
      eventClients.delete(id);
    }
  });
}

async function handleToolCall(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(response, 400, { ok: false, code: "bad_request", message: "본문은 객체여야 합니다." });
    return;
  }
  const { toolName, args } = body as { toolName?: unknown; args?: unknown };
  if (!isConnectorToolName(toolName)) {
    sendJson(response, 400, { ok: false, code: "unknown_tool", message: "알 수 없는 커넥터 도구입니다." });
    return;
  }
  if (!toolAllowedForRequest(request, toolName)) {
    sendJson(response, 403, {
      ok: false,
      code: "tool_not_allowed",
      message: "이 커넥터 프로필에서 허용되지 않는 도구입니다."
    });
    return;
  }
  let dispatch: WebgptDispatchRecord | null = null;
  if (isExternalConnectorRequest(request)) {
    try {
      dispatch = verifyPublicToolAccess(toolName, args ?? {});
    } catch (error) {
      sendJson(response, 403, {
        ok: false,
        code: "invalid_dispatch_token",
        message: error instanceof Error ? error.message : "유효한 WebGPT 작업 토큰이 없습니다."
      });
      return;
    }
  }
  const result = connectorTools.call(toolName, args ?? {});
  closeDispatchAfterPublicReceive(toolName, dispatch, result);
  sendJson(response, 200, result);
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
  auditMcp(request, body);
  if (!isJsonRpcRequest(body)) {
    sendJson(response, 400, jsonRpcError(null, -32600, "잘못된 JSON-RPC 요청입니다."));
    return;
  }
  const requestSessionId = mcpSessionIdFrom(request);
  if (isJsonRpcNotification(body)) {
    if (requestSessionId) {
      touchMcpSession(requestSessionId);
    }
    response.writeHead(202, mcpHeaders(requestSessionId ?? undefined));
    response.end();
    return;
  }

  switch (body.method) {
    case "initialize": {
      const params = mcpRequestParams(body.params);
      const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      const sessionId = requestSessionId ?? createMcpSession();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        ...mcpHeaders(sessionId)
      });
      response.end(JSON.stringify(jsonRpcResult(body.id, mcpInitializeResult(protocolVersion))));
      return;
    }
    case "ping":
      if (requestSessionId) {
        touchMcpSession(requestSessionId);
      }
      sendJson(response, 200, jsonRpcResult(body.id, {}));
      return;
    case "tools/list":
      if (requestSessionId) {
        touchMcpSession(requestSessionId);
      }
      sendJson(response, 200, jsonRpcResult(body.id, mcpToolsListResult(mcpAllowedToolNames(request))));
      return;
    case "tools/call": {
      if (requestSessionId) {
        touchMcpSession(requestSessionId);
      }
      const params = mcpRequestParams(body.params);
      if (!isConnectorToolName(params.name)) {
        sendJson(response, 200, jsonRpcError(body.id, -32602, "알 수 없는 VNplayer MCP 도구입니다.", { name: params.name }));
        return;
      }
      if (!toolAllowedForRequest(request, params.name)) {
        sendJson(response, 200, jsonRpcError(body.id, -32602, "이 MCP 프로필에서 허용되지 않는 VNplayer 도구입니다.", { name: params.name }));
        return;
      }
      const args = "arguments" in params ? params.arguments : {};
      let dispatch: WebgptDispatchRecord | null = null;
      if (isExternalConnectorRequest(request)) {
        try {
          dispatch = verifyPublicToolAccess(params.name, args ?? {});
        } catch (error) {
          auditMcp(request, body, {
            event: "tools/call_rejected",
            rejectReason: "invalid_dispatch_token",
            toolErrorMessage: error instanceof Error ? error.message : "유효한 WebGPT 작업 토큰이 없습니다."
          });
          sendJson(
            response,
            200,
            jsonRpcError(body.id, -32602, error instanceof Error ? error.message : "유효한 WebGPT 작업 토큰이 없습니다.", {
              name: params.name
            })
          );
          return;
        }
        if (!publicReceiveHasAuthoredLibraryContext(params.name, args ?? {}, dispatch)) {
          auditMcp(request, body, {
            event: "tools/call_rejected",
            rejectReason: "library_update_required",
            dispatchId: dispatch?.id
          });
          sendJson(
            response,
            200,
            jsonRpcError(
              body.id,
              -32602,
              "공개 WebGPT 턴 제출에는 최소 1개의 작성 라이브러리 갱신이 필요합니다. StoryTurn.libraryUpdates 배열에 이번 턴의 후과/표면/열린 문제를 직접 넣어 주세요.",
              { name: params.name }
            )
          );
          return;
        }
      }
      const result = connectorTools.call(params.name, args ?? {});
      const closedDispatch = closeDispatchAfterPublicReceive(params.name, dispatch, result);
      auditMcp(request, body, {
        event: "tools/call_result",
        dispatchId: dispatch?.id,
        dispatchClosed: Boolean(closedDispatch),
        toolResultOk: result.ok,
        toolResultCode: "code" in result ? result.code : undefined,
        toolResultMessage: "message" in result ? result.message : undefined,
        turnId: "turnId" in result ? result.turnId : undefined
      });
      sendJson(response, 200, jsonRpcResult(body.id, mcpContentResult(result, !result.ok)));
      return;
    }
    default:
      sendJson(response, 200, jsonRpcError(body.id, -32601, `지원하지 않는 MCP 메서드입니다: ${body.method}`));
  }
}

function handleMcpSse(request: IncomingMessage, response: ServerResponse): void {
  const sessionId = mcpSessionIdFrom(request) ?? createMcpSession();
  touchMcpSession(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...mcpHeaders(sessionId)
  });
  response.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, mcpHeaders());
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "vnplayer",
      tools: connectorTools.names
    });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/cg-assets/")) {
    if (!serveCgAsset(response, url.pathname)) {
      sendJson(response, 404, { ok: false, code: "cg_asset_not_found", message: "CG asset을 찾을 수 없습니다." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/cg-assets/import") {
    try {
      const body = await readBody(request, cgAssetMaxBytes + 4096);
      const args = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const result = await importCgAssetImage(args, connectorBaseUrl(request));
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "cg_asset_import_failed",
        message: error instanceof Error ? error.message : "CG asset을 가져오지 못했습니다."
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/connector/tools") {
    sendJson(response, 200, { ok: true, tools: connectorTools.names });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    handleEventStream(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/mcp" && request.headers.accept?.includes("text/event-stream")) {
    handleMcpSse(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/mcp") {
    sendJson(response, 200, {
      ok: true,
      service: "vnplayer-mcp",
      transport: "streamable-http",
      endpoint: `${publicConnectorBaseUrl(request)}/mcp`,
      sessions: mcpSessions.size,
      profile: isExternalConnectorRequest(request) ? "webgpt-authoring" : "local-full",
      tools: mcpAllowedToolNames(request)
    });
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/mcp") {
    const sessionId = mcpSessionIdFrom(request);
    if (sessionId) {
      mcpSessions.delete(sessionId);
    }
    response.writeHead(202, mcpHeaders(sessionId ?? undefined));
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/mcp") {
    try {
      const body = await readBody(request);
      await handleMcpRequest(request, response, body);
    } catch (error) {
      sendJson(response, 400, jsonRpcError(null, -32700, error instanceof Error ? error.message : "잘못된 JSON입니다."));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/webgpt/manifest") {
    sendJson(response, 200, buildWebGptManifest(publicConnectorBaseUrl(request), mcpAllowedToolNames(request)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/webgpt/openapi.json") {
    sendJson(response, 200, buildWebGptOpenApi(publicConnectorBaseUrl(request), mcpAllowedToolNames(request)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/author/providers") {
    const defaultProvider = authorProviderArg(null);
    sendJson(response, 200, {
      ok: true,
      defaultProvider,
      providers: [
        { id: "webgpt", label: authorProviderLabel("webgpt") },
        {
          id: "gemma4_local",
          label: authorProviderLabel("gemma4_local"),
          promptMode: "gemma-stateless-current",
          configuration: "server-side"
        }
      ]
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/connector/call") {
    try {
      const body = await readBody(request);
      await handleToolCall(request, response, body);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "bad_request",
        message: error instanceof Error ? error.message : "잘못된 요청입니다."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/webgpt/call") {
    try {
      const body = await readBody(request);
      await handleToolCall(request, response, body);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "bad_request",
        message: error instanceof Error ? error.message : "잘못된 요청입니다."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/webgpt/author-once") {
    try {
      const body = await readBody(request);
      const args = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const worldId = typeof args.worldId === "string" ? args.worldId.trim() : "";
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!worldId || !sessionId) {
        sendJson(response, 400, { ok: false, code: "bad_request", message: "worldId와 sessionId가 필요합니다." });
        return;
      }
      repository.getReaderState(worldId, sessionId);
      sendJson(response, 202, {
        ok: true,
        ...startTextAuthorJob({
          worldId,
          sessionId,
          baseUrl: publicConnectorBaseUrl(request),
          provider: authorProviderArg(args.provider),
          conversationMode: conversationModeArg(args.conversationMode)
        })
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "webgpt_author_start_failed",
        message: error instanceof Error ? error.message : "작성 작업을 시작하지 못했습니다."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/webgpt/cg-run") {
    try {
      const args = objectArgs(await readBody(request));
      const worldId = stringArg(args, "worldId");
      const sessionId = stringArg(args, "sessionId");
      const rawMaxJobs = typeof args.maxJobs === "number" ? args.maxJobs : Number(args.maxJobs ?? 2);
      const maxJobs = Math.max(1, Math.min(Number.isFinite(rawMaxJobs) ? Math.floor(rawMaxJobs) : 2, 4));
      const runner = startCgLaneJob({ worldId, sessionId, maxJobs, conversationMode: conversationModeArg(args.conversationMode) });
      sendJson(response, 202, { ok: true, ...runner, scope: { worldId, sessionId } });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "webgpt_cg_start_failed",
        message: error instanceof Error ? error.message : "CG WebGPT 작업을 시작하지 못했습니다."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/webgpt/record-action-and-author") {
    const requestReceivedAt = new Date().toISOString();
    try {
      const args = objectArgs(await readBody(request));
      const worldId = stringArg(args, "worldId");
      const sessionId = stringArg(args, "sessionId");
      const turnId = stringArg(args, "turnId");
      const kind = stringArg(args, "kind");
      if (kind !== "choice" && kind !== "freeform") {
        sendJson(response, 400, { ok: false, code: "invalid_action_kind", message: "kind는 choice 또는 freeform이어야 합니다." });
        return;
      }
      const activeDispatch = repository.activeWebgptDispatch(worldId, sessionId);
      if (activeDispatch) {
        sendJson(response, 409, {
          ok: false,
          code: "webgpt_dispatch_running",
          message: "이미 이 세션의 작성 작업이 진행 중입니다.",
          dispatchId: activeDispatch.id
        });
        return;
      }
      const action = repository.recordPlayerAction({
        worldId,
        sessionId,
        turnId,
        kind,
        label: optionalStringArg(args, "label"),
        text: stringArg(args, "text")
      });
      const actionRecordedAt = new Date().toISOString();
      const author = startTextAuthorJob({
        worldId,
        sessionId,
        baseUrl: publicConnectorBaseUrl(request),
        provider: authorProviderArg(args.provider),
        conversationMode: conversationModeArg(args.conversationMode),
        trigger: {
          type: "player_action",
          playerActionId: action.playerActionId,
          turnId,
          kind,
          label: optionalStringArg(args, "label")
        },
        serverTimings: {
          actionRequestReceivedAt: requestReceivedAt,
          actionRecordedAt
        }
      });
      sendJson(response, 202, {
        ok: true,
        ...action,
        ...author,
        timings: {
          actionRequestReceivedAt: requestReceivedAt,
          actionRecordedAt,
          responseSentAt: new Date().toISOString()
        }
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "record_action_author_start_failed",
        message: error instanceof Error ? error.message : "선택을 작성 lane에 전달하지 못했습니다."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/webgpt/dispatches/")) {
    const dispatchId = decodeURIComponent(url.pathname.slice("/api/webgpt/dispatches/".length));
    try {
      const body = await readBody(request);
      const args = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const rawStatus = args.status;
      if (rawStatus !== "succeeded" && rawStatus !== "failed") {
        sendJson(response, 400, {
          ok: false,
          code: "bad_request",
          message: "status는 succeeded 또는 failed여야 합니다."
        });
        return;
      }
      const dispatch = repository.finishWebgptDispatch({
        id: dispatchId,
        status: rawStatus,
        conversationId: typeof args.conversationId === "string" ? args.conversationId : null,
        result: args.result,
        errorMessage: typeof args.errorMessage === "string" ? args.errorMessage : null
      });
      publishWebgptDispatchChanged({
        worldId: dispatch.worldId,
        sessionId: dispatch.sessionId,
        dispatchId: dispatch.id,
        status: dispatch.status
      });
      sendJson(response, 200, { ok: true, dispatch });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "webgpt_dispatch_update_failed",
        message: error instanceof Error ? error.message : "WebGPT 작업 상태를 갱신하지 못했습니다."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/webgpt/tools/")) {
    const toolName = decodeURIComponent(url.pathname.slice("/api/webgpt/tools/".length));
    if (!isConnectorToolName(toolName)) {
      sendJson(response, 404, { ok: false, code: "unknown_tool", message: "알 수 없는 WebGPT 커넥터 도구입니다." });
      return;
    }
    if (!toolAllowedForRequest(request, toolName)) {
      sendJson(response, 403, {
        ok: false,
        code: "tool_not_allowed",
        message: "이 커넥터 프로필에서 허용되지 않는 WebGPT 도구입니다."
      });
      return;
    }
    try {
      const body = await readBody(request);
      const args = typeof body === "object" && body !== null && !Array.isArray(body) && "args" in body ? (body as { args?: unknown }).args : body;
      let dispatch: WebgptDispatchRecord | null = null;
      if (isExternalConnectorRequest(request)) {
        try {
          dispatch = verifyPublicToolAccess(toolName, args ?? {});
        } catch (error) {
          sendJson(response, 403, {
            ok: false,
            code: "invalid_dispatch_token",
            message: error instanceof Error ? error.message : "유효한 WebGPT 작업 토큰이 없습니다."
          });
          return;
        }
        if (!publicReceiveHasAuthoredLibraryContext(toolName, args ?? {}, dispatch)) {
          sendJson(response, 400, {
            ok: false,
            code: "library_update_required",
            message: "공개 WebGPT 턴 제출에는 최소 1개의 작성 라이브러리 갱신이 필요합니다. StoryTurn.libraryUpdates 배열에 이번 턴의 후과/표면/열린 문제를 직접 넣어 주세요."
          });
          return;
        }
      }
      const result = connectorTools.call(toolName, args ?? {});
      closeDispatchAfterPublicReceive(toolName, dispatch, result);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: "bad_request",
        message: error instanceof Error ? error.message : "잘못된 요청입니다."
      });
    }
    return;
  }

  sendJson(response, 404, { ok: false, code: "not_found", message: `경로가 없습니다: ${url.pathname}` });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`VNplayer backend listening on http://127.0.0.1:${port}`);
});
