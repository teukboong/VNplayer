import { connectorToolDefinitions, connectorToolNames, type ConnectorToolName } from "./manifest.js";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: {
        code: number;
        message: string;
        data?: unknown;
      };
    };

export const mcpProtocolVersion = "2025-06-18";

export function isConnectorToolName(value: unknown): value is ConnectorToolName {
  return typeof value === "string" && connectorToolNames.includes(value as ConnectorToolName);
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

export function isJsonRpcNotification(request: JsonRpcRequest): boolean {
  return !("id" in request);
}

export function mcpInitializeResult(requestedProtocolVersion?: string) {
  return {
    protocolVersion: requestedProtocolVersion || mcpProtocolVersion,
    capabilities: {
      tools: {}
    },
    serverInfo: {
      name: "VNplayer",
      version: "0.1.0"
    },
    instructions:
      "VNplayer는 실시간으로 집필되는 문학적 세계 플레이어다. 도구는 가시 양식, 복구/세션 상태, 저장 작업만 노출한다. 백엔드 서사 작성자로 쓰면 안 된다."
  };
}

export function mcpToolsListResult(allowedToolNames: readonly ConnectorToolName[] = connectorToolNames) {
  const allowed = new Set<ConnectorToolName>(allowedToolNames);
  return {
    tools: connectorToolDefinitions
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: `${tool.description}\n\n경계: ${tool.storyBoundary}`,
        inputSchema: tool.inputSchema
      }))
  };
}

export function mcpContentResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value)
      }
    ],
    isError
  };
}

export function jsonRpcResult(id: JsonRpcId | undefined, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result
  };
}

export function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error = data === undefined ? { code, message } : { code, message, data };
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error
  };
}

export function mcpRequestParams(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
