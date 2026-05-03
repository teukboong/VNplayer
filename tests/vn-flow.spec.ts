import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const firstTurn = {
  scene: {
    speaker: null,
    paragraphs: [
      "The archive room opens onto rain-bright glass, and the city beyond it waits like a sentence that has not decided where to break."
    ],
    background: "archive room",
    mood: "quiet tension"
  },
  concreteDelta: "The archive reveals a green desk lamp and a folder waiting under it.",
  interface: {
    statusRows: [
      { label: "Location", value: "Rain Archive", icon: "⌂" },
      { label: "Weather", value: "Glass rain", icon: "~" }
    ],
    scanRows: [
      {
        target: "Green desk lamp",
        className: "Object",
        distance: "Near",
        thought: "It feels less like furniture than an invitation."
      }
    ],
    progress: { eventName: "Opening", phrase: "The first clue is waiting." }
  },
  choices: [
    {
      label: "Follow the lamp",
      action: "Walk toward the green desk lamp and inspect the open folder.",
      tag: "정로",
      intent: "Move toward the first visible clue."
    },
    {
      label: "Call out",
      action: "Ask whether anyone else is in the archive.",
      tag: "관계",
      intent: "Test whether the archive answers back."
    },
    {
      label: "Check the windows",
      action: "Study the rain-bright glass before touching anything."
    },
    {
      label: "Pocket the paperclip",
      action: "Take the paperclip as a small anchor before reading."
    },
    {
      label: "Open the index",
      action: "Look for a Codex-style index entry about the Rain Archive.",
      tag: "코덱스"
    },
    {
      label: "Wait one minute",
      action: "Let the archive make the next small sound before acting.",
      tag: "흐름"
    }
  ]
};

const secondTurn = {
  scene: {
    speaker: "Archivist",
    paragraphs: [
      "The green lamp hums once. A paperclip slides by itself to the folder's edge, pointing at a page marked with your name.",
      "From the stacks, a calm voice answers as if the question was expected hours ago."
    ],
    background: "archive room",
    mood: "focused"
  },
  concreteDelta: "The paperclip moves by itself and points to a page marked with the reader's name.",
  libraryUpdates: [
    {
      kind: "encounter_surface",
      title: "Self-moving paperclip",
      body: {
        surface: "paperclip",
        visibleSignal: "It slides to the folder's edge by itself.",
        affordances: ["inspect", "touch", "compare with marked page"]
      },
      status: "active",
      scope: "scene",
      tags: ["surface", "paperclip"],
      updateReason: "The second turn made the paperclip an actionable surface."
    }
  ],
  choices: [
    {
      label: "Read the page",
      action: "Read the marked page before answering the voice."
    }
  ]
};

const secondTurnWithCgDecision = {
  ...secondTurn,
  cgDecision: {
    decision: "skip",
    reason: "The turn changes a small interaction surface, but the pinned archive moodboard already covers the visual field."
  }
};

const staleSchemaTurn = {
  scene: {
    speaker: null,
    paragraphs: [
      "The stale connector can only send ordinary paragraphs.",
      "이번 턴의 구체 변화: A brass tag appears on the locked drawer.",
      'LIBRARY_UPDATE_JSON: {"kind":"encounter_surface","title":"Brass drawer tag","body":{"surface":"brass tag","visibleSignal":"It appears on the locked drawer.","affordances":["inspect","touch"]},"status":"active","scope":"scene","tags":["drawer","surface"],"updateReason":"stale connector fallback"}'
    ],
    background: "archive room",
    mood: "narrow"
  },
  choices: [
    {
      label: "Inspect the tag",
      action: "Inspect the brass tag on the locked drawer."
    }
  ],
  cgRequest: {
    shouldGenerate: true,
    priority: "normal",
    subject: "the brass tag on the locked drawer in the archive room",
    visibleAnchors: ["brass tag", "locked drawer", "archive room"],
    composition: "close still life, the tag catching narrow lamplight",
    mood: "quiet pressure",
    avoid: ["readable text", "new symbols", "extra characters"],
    rationale: "The tag is the concrete surface this turn leaves behind."
  },
  actionAdjudication: {
    kind: "accepted",
    reason: "Listening for the rain is possible from the current archive position.",
    constraintTouched: ["knowledge"]
  }
};

const carryoverTurn = {
  ...secondTurn,
  scene: {
    ...secondTurn.scene,
    paragraphs: ["The green lamp hums once more, but no new image-worthy surface replaces the brass tag yet."]
  },
  concreteDelta: "The story advances without replacing the last attached CG background.",
  cgDecision: {
    decision: "skip",
    reason: "This beat continues the existing visual pressure without a new CG-worthy surface."
  },
  actionAdjudication: {
    kind: "accepted",
    reason: "The previous freeform listen action can carry into this continuation.",
    constraintTouched: ["knowledge"]
  }
};

async function callTool<T>(page: Page, toolName: string, args: Record<string, unknown>): Promise<T> {
  const response = await page.request.post(`/api/webgpt/tools/${toolName}`, { data: args });
  await expect(response).toBeOK();
  return (await response.json()) as T;
}

async function getWorld(page: Page, title: string) {
  const body = await callTool<{
    ok: true;
    worlds: Array<{ title: string; worldId: string; latestSessionId: string | null; hasWebgptSessionUrl: boolean }>;
  }>(page, "vn_list_worlds", {});
  const world = body.worlds.find((candidate) => candidate.title === title);
  expect(world).toBeTruthy();
  expect(world?.latestSessionId).toBeTruthy();
  return world as { title: string; worldId: string; latestSessionId: string; hasWebgptSessionUrl: boolean };
}

const externalMcpHeaders = {
  "x-vnplayer-external-host": "vnplayer-frontdoor.example.workers.dev",
  "x-vnplayer-external-proto": "https"
};

const tinyPngDataUrl = solidPngDataUrl(64, 64);
const testBackendBaseUrl = process.env.VNPLAYER_TEST_BACKEND_BASE_URL ?? "http://127.0.0.1:4274";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function solidPngDataUrl(width: number, height: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let index = 1; index < row.length; index += 3) {
    row[index] = 224;
    row[index + 1] = 232;
    row[index + 2] = 236;
  }
  const rawPixels = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rawPixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("world entry, turn steering, restore metadata, and existing-world loading", async ({ page }) => {
  const worldTitle = `Rain Archive ${Date.now()}`;
  const customCgStyle = "Ink-washed black lines, torn paper texture, severe empty margins, no parody style.";

  await page.goto("/");

  const manifestResponse = await page.request.get("/api/webgpt/manifest");
  await expect(manifestResponse).toBeOK();
  const manifest = (await manifestResponse.json()) as { tools: Array<{ name: string; inputSchema: unknown }> };
  expect(manifest.tools.some((tool) => tool.name === "vn_submit_turn" && tool.inputSchema)).toBe(true);

  const openApiResponse = await page.request.get("/api/webgpt/openapi.json");
  await expect(openApiResponse).toBeOK();
  const openApi = (await openApiResponse.json()) as { paths: Record<string, unknown> };
  expect(openApi.paths["/api/webgpt/tools/vn_get_current_form"]).toBeTruthy();

  const mcpInitializeResponse = await page.request.post("/mcp", {
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        clientInfo: { name: "vnplayer-test", version: "0.1.0" }
      }
    }
  });
  await expect(mcpInitializeResponse).toBeOK();
  const mcpInitialize = (await mcpInitializeResponse.json()) as { result: { capabilities: { tools: unknown } } };
  expect(mcpInitialize.result.capabilities.tools).toBeTruthy();

  const mcpToolsResponse = await page.request.post("/mcp", {
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  });
  await expect(mcpToolsResponse).toBeOK();
  const mcpTools = (await mcpToolsResponse.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
  expect(mcpTools.result.tools.some((tool) => tool.name === "vn_submit_turn" && tool.inputSchema)).toBe(true);

  const externalMcpInitializeResponse = await page.request.post("/mcp", {
    headers: externalMcpHeaders,
    data: {
      jsonrpc: "2.0",
      id: 21,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        clientInfo: { name: "vnplayer-external-test", version: "0.1.0" }
      }
    }
  });
  await expect(externalMcpInitializeResponse).toBeOK();

  const externalMcpToolsResponse = await page.request.post("/mcp", {
    headers: externalMcpHeaders,
    data: { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} }
  });
  await expect(externalMcpToolsResponse).toBeOK();
  const externalMcpTools = (await externalMcpToolsResponse.json()) as {
    result: { tools: Array<{ name: string; inputSchema: unknown }> };
  };
  expect(externalMcpTools.result.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["vn_receive_visible_turn_v2", "vn_get_library_docs", "vn_get_library_outline"])
  );
  expect(externalMcpTools.result.tools.some((tool) => tool.name.startsWith("vn_upsert_"))).toBe(false);
  expect(externalMcpTools.result.tools.some((tool) => tool.name === "vn_submit_turn")).toBe(false);
  const receiveToolSchema = externalMcpTools.result.tools.find((tool) => tool.name === "vn_receive_visible_turn_v2")?.inputSchema as
    | { properties?: { turn?: { required?: string[]; properties?: { libraryUpdates?: { minItems?: number } } } } }
    | undefined;
  expect(receiveToolSchema?.properties?.turn?.required).toContain("libraryUpdates");
  expect(receiveToolSchema?.properties?.turn?.properties?.libraryUpdates?.minItems).toBe(1);

  const externalBlockedCallResponse = await page.request.post("/mcp", {
    headers: externalMcpHeaders,
    data: {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "vn_submit_turn",
        arguments: {}
      }
    }
  });
  await expect(externalBlockedCallResponse).toBeOK();
  const externalBlockedCall = (await externalBlockedCallResponse.json()) as { error?: { code: number; message: string } };
  expect(externalBlockedCall.error?.message).toContain("허용되지 않는");

  const externalDirectToolResponse = await page.request.post("/api/webgpt/tools/vn_list_worlds", {
    headers: externalMcpHeaders,
    data: {}
  });
  expect(externalDirectToolResponse.status()).toBe(403);

  const externalGenericToolResponse = await page.request.post("/api/webgpt/call", {
    headers: externalMcpHeaders,
    data: { toolName: "vn_list_worlds", args: {} }
  });
  expect(externalGenericToolResponse.status()).toBe(403);

  const externalReceiveWithoutTokenResponse = await page.request.post("/mcp", {
    headers: externalMcpHeaders,
    data: {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "vn_receive_visible_turn_v2",
        arguments: {
          worldId: "world_missing",
          sessionId: "session_missing",
          turn: firstTurn
        }
      }
    }
  });
  await expect(externalReceiveWithoutTokenResponse).toBeOK();
  const externalReceiveWithoutToken = (await externalReceiveWithoutTokenResponse.json()) as { error?: { message: string } };
  expect(externalReceiveWithoutToken.error?.message).toContain("활성 WebGPT 작업이 없어서");

  const externalOutlineWithoutDispatchResponse = await page.request.post("/mcp", {
    headers: externalMcpHeaders,
    data: {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "vn_get_library_outline",
        arguments: {
          worldId: "world_missing",
          sessionId: "session_missing"
        }
      }
    }
  });
  await expect(externalOutlineWithoutDispatchResponse).toBeOK();
  const externalOutlineWithoutDispatch = (await externalOutlineWithoutDispatchResponse.json()) as { error?: { message: string } };
  expect(externalOutlineWithoutDispatch.error?.message).toContain("활성 WebGPT 작업이 없어서");

  await expect(page.getByRole("region", { name: "세계 진입" })).toBeVisible();
  await expect(page.getByLabel("세계관 시드")).toBeVisible();
  await expect(page.getByRole("button", { name: "기존 세계 저장된 세계를 불러와 이야기를 계속한다." })).toBeVisible();
  await page.route("**/api/webgpt/author-once", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, started: true, dispatchId: "dispatch_test_auto_text_lane" })
    });
  });
  await page.route("**/api/webgpt/record-action-and-author", async (route) => {
    const args = route.request().postDataJSON() as Record<string, unknown>;
    const actionResponse = await page.request.post("/api/webgpt/tools/vn_record_player_action", { data: args });
    const actionBody = (await actionResponse.json()) as { ok?: boolean; playerActionId?: string; message?: string };
    if (!actionResponse.ok() || actionBody.ok === false || !actionBody.playerActionId) {
      await route.fulfill({
        status: actionResponse.status(),
        contentType: "application/json",
        body: JSON.stringify(actionBody)
      });
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        started: true,
        playerActionId: actionBody.playerActionId,
        dispatchId: "dispatch_test_action_text_lane"
      })
    });
  });

  await page.getByLabel("세계관 시드").fill(
    [
      worldTitle,
      "A literary mystery about memory, weather, and quiet choices.",
      "Characters:",
      "- Archivist: a calm keeper who answers only from visible records.",
      "Locations:",
      "- Rain Archive: glass rain, green desk lamp, damp paper grain."
    ].join("\n")
  );
  await page.getByRole("checkbox", { name: "랜덤 시드 사용" }).check();
  await page.getByLabel("랜덤 시드 값").fill("seed_smoke_001");
  await page.getByText("CG 그림체").click();
  await page.getByLabel("기본 이미지 프롬프트").fill(customCgStyle);
  await page.getByRole("button", { name: "세계 열기" }).click();

  await expect(page.getByText("세계가 열렸습니다. WebGPT가 첫 장면을 쓰고 있습니다.")).toBeVisible();
  await expect(page.getByText("아직 첫 장면이 도착하지 않았습니다")).toBeVisible();
  await expect(page.getByLabel("디버그 도구 표면")).toHaveCount(0);
  await expect(page.getByText("가시 턴 양식")).toHaveCount(0);

  const createdWorld = await getWorld(page, worldTitle);
  const initialOutline = await callTool<{
    ok: true;
    docs: Array<{ docId: string; kind: string; title: string; pinned?: boolean; tags: string[] }>;
  }>(page, "vn_get_library_outline", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    pinnedOnly: true,
    visibleToLlmOnly: true
  });
  expect(initialOutline.docs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "world_note", title: "세계관 시드", pinned: true }),
      expect.objectContaining({ kind: "style_guide", title: "초기 문체와 CG 기준", pinned: true }),
      expect.objectContaining({ kind: "character_card", title: "시드 인물 카드", pinned: true }),
      expect.objectContaining({ kind: "location_card", title: "시드 장소 카드", pinned: true })
    ])
  );
  const initialBoards = await callTool<{
    ok: true;
    boards: Array<{ id: string; kind: string; title: string; pinned: boolean; imageUrl: string | null }>;
  }>(page, "vn_list_cg_reference_boards", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    pinnedOnly: true
  });
  expect(initialBoards.boards).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "world_mood", title: "세계관 시드 참조", pinned: true, imageUrl: null }),
      expect.objectContaining({ kind: "world_mood", title: "초기 문체와 CG 기준 참조", pinned: true, imageUrl: null }),
      expect.objectContaining({ kind: "character", title: "시드 인물 카드 참조", pinned: true, imageUrl: null }),
      expect.objectContaining({ kind: "location", title: "시드 장소 카드 참조", pinned: true, imageUrl: null })
    ])
  );
  const startupReferenceTitles: string[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const startupBoardJob = await callTool<{
      ok: true;
      job: { id: string; kind: string; lane: string; status: string; payload: { boardId: string; title: string; prompt: string } } | null;
    }>(page, "vn_claim_next_cg_job", {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId
    });
    if (!startupBoardJob.job) {
      break;
    }
    expect(startupBoardJob.job.kind).toBe("cg_reference_board");
    expect(startupBoardJob.job.lane).toBe("cg_side");
    startupReferenceTitles.push(startupBoardJob.job.payload.title);
    await callTool(page, "vn_attach_cg_reference_board", {
      worldId: createdWorld.worldId,
      boardId: startupBoardJob.job.payload.boardId,
      jobId: startupBoardJob.job.id,
      imageUrl: `https://example.com/startup-${attempt}.png`
    });
  }
  expect(startupReferenceTitles).toEqual(
    expect.arrayContaining(["세계관 시드 참조", "초기 문체와 CG 기준 참조", "시드 인물 카드 참조", "시드 장소 카드 참조"])
  );
  const legacyReceive = await callTool<{ ok: false; code: string; message: string }>(page, "vn_receive_visible_turn", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    turn: firstTurn
  });
  expect(legacyReceive.ok).toBe(false);
  expect(legacyReceive.code).toBe("legacy_receive_tool_retired");
  const missingLibraryReceive = await callTool<{ ok: false; code: string; message: string }>(page, "vn_receive_visible_turn_v2", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    turn: {
      ...firstTurn,
      cgDecision: {
        decision: "skip",
        reason: "Smoke check for the v2 receive contract."
      }
    }
  });
  expect(missingLibraryReceive.ok).toBe(false);
  expect(missingLibraryReceive.code).toBe("library_update_required");
  const missingCgDecisionReceive = await callTool<{ ok: false; code: string; message: string }>(page, "vn_receive_visible_turn_v2", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    turn: secondTurn
  });
  expect(missingCgDecisionReceive.ok).toBe(false);
  expect(missingCgDecisionReceive.code).toBe("cg_decision_required");
  const moodBoardPrompt = "Pinned moodboard: pale green glass, crooked archive silhouettes, damp paper grain, low contrast.";
  const moodBoard = await callTool<{
    ok: true;
    board: { id: string; kind: string; title: string; prompt: string; pinned: boolean; imageUrl: string | null };
  }>(page, "vn_upsert_cg_reference_board", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    kind: "world_mood",
    title: "Rain archive moodboard",
    prompt: moodBoardPrompt,
    pinned: true,
    createdBy: "user"
  });
  expect(moodBoard.board.pinned).toBe(true);
  expect(moodBoard.board.imageUrl).toBeNull();
  const claimedBoardJob = await callTool<{
    ok: true;
    job: { id: string; kind: string; lane: string; status: string; payload: { boardId: string; title: string; prompt: string } } | null;
  }>(page, "vn_claim_next_cg_job", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(claimedBoardJob.job?.kind).toBe("cg_reference_board");
  expect(claimedBoardJob.job?.lane).toBe("cg_side");
  expect(claimedBoardJob.job?.status).toBe("running");
  expect(claimedBoardJob.job?.payload.boardId).toBe(moodBoard.board.id);
  expect(claimedBoardJob.job?.payload.prompt).toContain(moodBoardPrompt);
  const attachedBoard = await callTool<{
    ok: true;
    board: { id: string; imageUrl: string | null };
  }>(page, "vn_attach_cg_reference_board", {
    worldId: createdWorld.worldId,
    boardId: moodBoard.board.id,
    jobId: claimedBoardJob.job?.id,
    imageUrl: "https://example.com/rain-archive-moodboard.png"
  });
  expect(attachedBoard.board.imageUrl).toBe("https://example.com/rain-archive-moodboard.png");
  const workerFixtureDir = join(tmpdir(), `vnplayer-cg-worker-${Date.now()}`);
  mkdirSync(workerFixtureDir, { recursive: true });
  const localWorkerImagePath = join(workerFixtureDir, "worker-result.png");
  writeFileSync(localWorkerImagePath, Buffer.from(tinyPngDataUrl.split(",")[1] ?? "", "base64"));
  const fakeWrapperPath = join(workerFixtureDir, "fake-webgpt-wrapper.mjs");
  writeFileSync(
    fakeWrapperPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ image_file: process.env.VNPLAYER_FAKE_CG_IMAGE_PATH, answer_markdown: 'local image artifact ready', raw_conversation_id: 'cg-smoke-session' }));"
    ].join("\n")
  );
  chmodSync(fakeWrapperPath, 0o755);
  const workerBoardPrompt = "Worker moodboard: milky archive glass, paper dust, quiet negative space.";
  const workerBoard = await callTool<{
    ok: true;
    board: { id: string; imageUrl: string | null };
  }>(page, "vn_upsert_cg_reference_board", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    kind: "world_mood",
    title: "Worker-imported board",
    prompt: workerBoardPrompt,
    pinned: false,
    createdBy: "user"
  });
  expect(workerBoard.board.imageUrl).toBeNull();
  const workerResult = spawnSync(
    process.execPath,
    [
      "scripts/webgpt-cg-once.mjs",
      "--webgpt-mcp-wrapper",
      fakeWrapperPath,
      "--local-base-url",
      testBackendBaseUrl,
      "--world-id",
      createdWorld.worldId,
      "--session-id",
      createdWorld.latestSessionId,
      "--artifact-dir",
      join(workerFixtureDir, "artifacts")
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, VNPLAYER_FAKE_CG_IMAGE_PATH: localWorkerImagePath },
      encoding: "utf8"
    }
  );
  expect(workerResult.status, workerResult.stderr).toBe(0);
  const workerBoardState = await callTool<{ ok: true; boards: Array<{ id: string; imageUrl: string | null }> }>(
    page,
    "vn_list_cg_reference_boards",
    {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId,
      limit: 20
    }
  );
  const importedWorkerBoard = workerBoardState.boards.find((board) => board.id === workerBoard.board.id);
  expect(importedWorkerBoard?.imageUrl).toContain("/api/cg-assets/");
  const pinnedCgSessionState = await callTool<{ ok: true; state: { cgSessionUrl: string | null } }>(page, "vn_get_reader_state", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(pinnedCgSessionState.state.cgSessionUrl).toBe("https://chatgpt.com/c/cg-smoke-session");
  const moodBoards = await callTool<{ ok: true; boards: Array<{ id: string; prompt: string; pinned: boolean }> }>(
    page,
    "vn_list_cg_reference_boards",
    {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId,
      pinnedOnly: true
    }
  );
  expect(moodBoards.boards).toEqual(expect.arrayContaining([expect.objectContaining({ id: moodBoard.board.id, prompt: moodBoardPrompt })]));
  const docResult = await callTool<{ ok: true; docId: string; versionId: string }>(page, "vn_upsert_library_doc", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    kind: "style_guide",
    title: "Smoke style",
    body: { note: "Use rain, glass, and quiet pressure." },
    visibleToLlm: true,
    visibleToPlayer: true,
    createdBy: "user"
  });
  await callTool(page, "vn_set_library_doc_pinned", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    docId: docResult.docId,
    pinned: true,
    createdBy: "user"
  });
  const pinnedDocs = await callTool<{ ok: true; docs: Array<{ docId: string; pinned?: boolean }> }>(page, "vn_get_library_docs", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    pinnedOnly: true
  });
  expect(pinnedDocs.docs.some((doc) => doc.docId === docResult.docId && doc.pinned)).toBe(true);
  const ruleResult = await callTool<{ ok: true; docId: string; versionId: string }>(page, "vn_upsert_world_rule", {
    worldId: createdWorld.worldId,
    title: "Rain archive rule",
    body: { text: "Rain reveals stored memory only when reflected through glass." },
    createdBy: "user"
  });
  const consequenceResult = await callTool<{ ok: true; docId: string; versionId: string }>(page, "vn_upsert_consequence_note", {
    worldId: createdWorld.worldId,
    title: "The folder has noticed the reader",
    body: {
      originTurnId: "turn_pending",
      visibleCause: "The reader chose to follow the lamp.",
      visibleFallout: "The archive can now address the reader through labeled paper.",
      expectedReturn: "when_touched"
    },
    status: "active",
    scope: "scene",
    tags: ["knowledge", "archive"],
    createdBy: "llm"
  });
  await callTool(page, "vn_upsert_encounter_surface", {
    worldId: createdWorld.worldId,
    title: "Archive desk surface",
    body: {
      surfaces: [
        {
          label: "Green desk lamp",
          visibleSignal: "The lamp hums toward the folder.",
          affordances: ["inspect", "touch", "wait"]
        }
      ]
    },
    status: "active",
    scope: "scene",
    tags: ["surface", "archive"],
    createdBy: "llm"
  });
  await callTool(page, "vn_upsert_dialogue_stance", {
    worldId: createdWorld.worldId,
    title: "Archivist waits before answering",
    body: {
      actor: "Archivist",
      stance: "withholding",
      visibleSignal: "The voice answers as if it expected the question."
    },
    status: "active",
    scope: "scene",
    tags: ["dialogue"],
    createdBy: "llm"
  });
  const outline = await callTool<{ ok: true; docs: Array<{ docId: string; kind: string; title: string; versionId: string }> }>(
    page,
    "vn_get_library_outline",
    {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId
    }
  );
  expect(outline.docs.some((doc) => doc.docId === ruleResult.docId && doc.kind === "world_rule")).toBe(true);
  const filteredOutline = await callTool<{ ok: true; docs: Array<{ docId: string; kind: string; scope: string; tags: string[] }> }>(
    page,
    "vn_get_library_outline",
    {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId,
      kinds: ["consequence_note"],
      status: ["active"],
      scopes: ["scene"],
      tags: ["archive"]
    }
  );
  expect(filteredOutline.docs).toEqual(
    expect.arrayContaining([expect.objectContaining({ docId: consequenceResult.docId, kind: "consequence_note", scope: "scene" })])
  );

  const firstSubmit = await callTool<{ turnId: string; warnings: Array<{ code: string; message: string; path?: string }> }>(page, "vn_submit_turn", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    source: "llm",
    turn: firstTurn
  });
  expect(firstSubmit.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["short_scene_paragraphs", "short_scene_text"]));

  const readingSurface = page.getByLabel("읽기 화면");
  await expect(readingSurface.locator(".prose-block").getByText("The archive room opens onto rain-bright glass")).toBeVisible();
  await readingSurface.getByText("장면 상태").click();
  await expect(readingSurface.getByText("Opening")).toBeVisible();
  await expect(readingSurface.getByText("Green desk lamp", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open the index/ })).toBeVisible();
  await page.getByRole("button", { name: /Follow the lamp/ }).click();
  await expect(page.getByText("선택을 보냈습니다. WebGPT가 다음 장면을 쓰고 있습니다.")).toBeVisible();

  const formAfterChoice = await callTool<{
    ok: true;
    form: {
      readingPacket: {
        latestPlayerAction: { text: string } | null;
        activeLibraryDocs: Array<{ docId: string; title: string; pinned?: boolean }>;
        libraryOutline: Array<{ docId: string; kind: string; title: string; status: string; scope: string; tags: string[] }>;
      };
      responseShape: string;
    };
  }>(page, "vn_get_current_form", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(formAfterChoice.form.readingPacket.latestPlayerAction?.text).toContain("Walk toward the green desk lamp");
  expect(formAfterChoice.form.readingPacket.activeLibraryDocs.some((doc) => doc.docId === docResult.docId && doc.pinned)).toBe(true);
  expect(formAfterChoice.form.readingPacket.libraryOutline.some((doc) => doc.docId === ruleResult.docId && doc.kind === "world_rule")).toBe(true);
  expect(formAfterChoice.form.readingPacket.libraryOutline.some((doc) => doc.kind === "encounter_surface" && doc.tags.includes("surface"))).toBe(true);

  const sessionSettings = await callTool<{
    ok: true;
    session: { autoCgEnabled: boolean; narrativeLevel: number; detailLevel: number };
  }>(page, "vn_update_session_settings", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    autoCgEnabled: false,
    narrativeLevel: 3,
    detailLevel: 1
  });
  expect(sessionSettings.session.autoCgEnabled).toBe(false);
  expect(sessionSettings.session.narrativeLevel).toBe(3);
  expect(sessionSettings.session.detailLevel).toBe(1);
  const formAfterSettings = await callTool<{
    ok: true;
    form: { instruction: string; readingPacket: { autoCgEnabled: boolean; narrativeLevel: number; detailLevel: number } };
  }>(page, "vn_get_current_form", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(formAfterSettings.form.readingPacket.autoCgEnabled).toBe(false);
  expect(formAfterSettings.form.readingPacket.narrativeLevel).toBe(3);
  expect(formAfterSettings.form.readingPacket.detailLevel).toBe(1);
  expect(formAfterSettings.form.instruction).toContain("전개 속도는 3, 빠름입니다.");
  expect(formAfterSettings.form.instruction).toContain("묘사 밀도는 1, 간결입니다.");

  await callTool(page, "vn_receive_visible_turn_v2", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    turn: secondTurnWithCgDecision
  });
  const outlineAfterSecondTurn = await callTool<{ ok: true; docs: Array<{ kind: string; title: string; tags: string[] }> }>(
    page,
    "vn_get_library_outline",
    {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId,
      kinds: ["encounter_surface"],
      tags: ["paperclip"]
    }
  );
  expect(outlineAfterSecondTurn.docs).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "encounter_surface", title: "Self-moving paperclip" })])
  );
  await page.getByRole("button", { name: "새로고침" }).click();
  await expect(readingSurface.locator(".prose-block").getByText("The green lamp hums once")).toBeVisible();
  await readingSurface.getByText("서술 로그").click();
  await expect(readingSurface.locator(".narrative-log")).toContainText("2턴");
  await expect(readingSurface.locator(".narrative-log")).toContainText("The archive reveals a green desk lamp");
  const firstLogTurn = readingSurface.locator(".narrative-log-turn").filter({ hasText: "#1" });
  await firstLogTurn.locator("summary").getByText("The archive reveals a green desk lamp").click();
  await expect(firstLogTurn.getByText("The archive room opens onto rain-bright glass")).toBeVisible();
  await page.getByLabel("읽기 화면").getByLabel("자유 행동").fill("Listen for the rain behind the shelves.");
  await page.getByRole("button", { name: "전하기" }).click();
  await expect(page.getByText("행동을 보냈습니다. WebGPT가 다음 장면을 쓰고 있습니다.")).toBeVisible();
  const formAfterFreeform = await callTool<{
    ok: true;
    form: { readingPacket: { latestPlayerAction: { text: string } | null } };
  }>(page, "vn_get_current_form", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(formAfterFreeform.form.readingPacket.latestPlayerAction?.text).toContain("Listen for the rain behind the shelves.");

  await callTool(page, "vn_submit_turn", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    source: "llm",
    turn: staleSchemaTurn
  });
  const outlineAfterStaleTurn = await callTool<{ ok: true; docs: Array<{ kind: string; title: string; tags: string[] }> }>(
    page,
    "vn_get_library_outline",
    {
      worldId: createdWorld.worldId,
      sessionId: createdWorld.latestSessionId,
      kinds: ["encounter_surface"],
      tags: ["drawer"]
    }
  );
  expect(outlineAfterStaleTurn.docs).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "encounter_surface", title: "Brass drawer tag" })])
  );
  const autoOffCgState = await callTool<{
    ok: true;
    state: {
      session: { autoCgEnabled: boolean; narrativeLevel: number; detailLevel: number };
      currentCgAsset: { id: string } | null;
    };
  }>(page, "vn_get_reader_state", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(autoOffCgState.state.session.autoCgEnabled).toBe(false);
  expect(autoOffCgState.state.session.narrativeLevel).toBe(3);
  expect(autoOffCgState.state.session.detailLevel).toBe(1);
  expect(autoOffCgState.state.currentCgAsset).toBeNull();
  const manualCgRequest = await callTool<{
    ok: true;
    asset: { id: string; status: string; provider: string | null };
  }>(page, "vn_prepare_cg_asset", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(manualCgRequest.asset.status).toBe("requested");
  await callTool(page, "vn_update_session_settings", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    autoCgEnabled: true,
    narrativeLevel: 2,
    detailLevel: 2
  });

  const cgState = await callTool<{
    ok: true;
    state: {
      world: { cgStylePrompt: string };
      cgReferenceBoards: Array<{ id: string; title: string; prompt: string; pinned: boolean }>;
      currentCgAsset: { id: string; jobId: string | null; status: string; provider: string | null; prompt: string; turnId: string } | null;
    };
  }>(page, "vn_get_reader_state", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(cgState.state.world.cgStylePrompt).toBe(customCgStyle);
  expect(cgState.state.cgReferenceBoards).toEqual(expect.arrayContaining([expect.objectContaining({ id: moodBoard.board.id, pinned: true })]));
  expect(cgState.state.currentCgAsset).toBeTruthy();
  expect(cgState.state.currentCgAsset?.status).toBe("requested");
  expect(cgState.state.currentCgAsset?.provider).toBe("webgpt");
  expect(cgState.state.currentCgAsset?.jobId).toBeTruthy();
  expect(cgState.state.currentCgAsset?.prompt).toContain("text lane subject");
  expect(cgState.state.currentCgAsset?.prompt).toContain("the brass tag on the locked drawer");
  expect(cgState.state.currentCgAsset?.prompt).toContain(customCgStyle);
  expect(cgState.state.currentCgAsset?.prompt).not.toContain("utterly pathetic");
  expect(cgState.state.currentCgAsset?.prompt).toContain("Pinned CG reference boards");
  expect(cgState.state.currentCgAsset?.prompt).toContain(moodBoardPrompt);

  const cgResult = await callTool<{
    ok: true;
    asset: { id: string; jobId: string | null; status: string; provider: string | null; prompt: string; turnId: string };
  }>(page, "vn_prepare_cg_asset", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(cgResult.asset.status).toBe("requested");
  expect(cgResult.asset.provider).toBe("webgpt");
  expect(cgResult.asset.jobId).toBe(cgState.state.currentCgAsset?.jobId);
  expect(cgResult.asset.turnId).toBeTruthy();
  expect(cgResult.asset.prompt).toContain("committed visible story text only");
  expect(cgResult.asset.prompt).toContain("The stale connector can only send ordinary paragraphs.");
  expect(cgResult.asset.prompt).toContain(customCgStyle);
  expect(cgResult.asset.prompt).not.toContain("utterly pathetic");
  expect(cgResult.asset.prompt).toContain(moodBoardPrompt);
  const updatedCgStyle = "Flat gouache, pale blue paper grain, deliberately elegant but slightly warped silhouettes.";
  await callTool(page, "vn_update_world_cg_style_prompt", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    cgStylePrompt: updatedCgStyle
  });
  const updatedCgStyleState = await callTool<{ ok: true; state: { world: { cgStylePrompt: string } } }>(page, "vn_get_reader_state", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(updatedCgStyleState.state.world.cgStylePrompt).toBe(updatedCgStyle);
  const claimedCgJob = await callTool<{
    ok: true;
    job: {
      id: string;
      kind: string;
      lane: string;
      status: string;
      targetTurnId: string;
      conversationId: string | null;
      payload: { assetId: string; cgRequest: { subject: string } };
    } | null;
  }>(page, "vn_claim_next_cg_job", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(claimedCgJob.job?.id).toBe(cgResult.asset.jobId);
  expect(claimedCgJob.job?.kind).toBe("cg_asset");
  expect(claimedCgJob.job?.lane).toBe("cg_side");
  expect(claimedCgJob.job?.status).toBe("running");
  expect(claimedCgJob.job?.conversationId).toBe("cg-smoke-session");
  expect(claimedCgJob.job?.payload.assetId).toBe(cgResult.asset.id);
  expect(claimedCgJob.job?.payload.cgRequest.subject).toContain("brass tag");
  const failedCg = await callTool<{
    ok: true;
    asset: { id: string; status: string; imageUrl: string | null; generatedByLane: string | null; errorMessage?: string | null };
  }>(page, "vn_attach_cg_asset", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    assetId: cgResult.asset.id,
    imageUrl: null,
    provider: "webgpt",
    conversationId: "cg-failed-session",
    errorMessage: "Transient WebGPT image generation failure."
  });
  expect(failedCg.asset.status).toBe("failed");
  expect(failedCg.asset.imageUrl).toBeNull();
  const failedCgSessionState = await callTool<{ ok: true; state: { cgSessionUrl: string | null } }>(page, "vn_get_reader_state", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(failedCgSessionState.state.cgSessionUrl).toBe("https://chatgpt.com/c/cg-failed-session");
  const retriedCgJob = await callTool<{
    ok: true;
    job: { id: string; kind: string; lane: string; status: string; errorMessage: string | null };
  }>(page, "vn_retry_cg_job", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    jobId: claimedCgJob.job?.id
  });
  expect(retriedCgJob.job.id).toBe(claimedCgJob.job?.id);
  expect(retriedCgJob.job.kind).toBe("cg_asset");
  expect(retriedCgJob.job.lane).toBe("cg_side");
  expect(retriedCgJob.job.status).toBe("queued");
  expect(retriedCgJob.job.errorMessage).toBeNull();
  const reclaimedCgJob = await callTool<{
    ok: true;
    job: { id: string; kind: string; lane: string; status: string; conversationId: string | null; payload: { assetId: string } } | null;
  }>(page, "vn_claim_next_cg_job", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId
  });
  expect(reclaimedCgJob.job?.id).toBe(claimedCgJob.job?.id);
  expect(reclaimedCgJob.job?.status).toBe("running");
  expect(reclaimedCgJob.job?.conversationId).toBe("cg-failed-session");
  expect(reclaimedCgJob.job?.payload.assetId).toBe(cgResult.asset.id);
  const importedCgImageResponse = await page.request.post("/api/cg-assets/import", {
    data: { dataUrl: tinyPngDataUrl }
  });
  await expect(importedCgImageResponse).toBeOK();
  const importedCgImage = (await importedCgImageResponse.json()) as { ok: true; assetUrl: string; sha256: string; mimeType: string };
  expect(importedCgImage.assetUrl).toContain("/api/cg-assets/");
  expect(importedCgImage.mimeType).toBe("image/png");
  const importedCgImageGet = await page.request.get(importedCgImage.assetUrl.replace(testBackendBaseUrl, ""));
  await expect(importedCgImageGet).toBeOK();
  expect(importedCgImageGet.headers()["content-type"]).toContain("image/png");
  const attachedCg = await callTool<{
    ok: true;
    asset: { id: string; status: string; imageUrl: string | null; generatedByLane: string | null };
  }>(page, "vn_attach_cg_asset", {
    worldId: createdWorld.worldId,
    sessionId: createdWorld.latestSessionId,
    assetId: cgResult.asset.id,
    imageUrl: importedCgImage.assetUrl,
    altText: "Brass tag on a locked archive drawer.",
    provider: "webgpt"
  });
  expect(attachedCg.asset.status).toBe("attached");
  expect(attachedCg.asset.imageUrl).toBe(importedCgImage.assetUrl);

  await page.getByRole("button", { name: "도구 열기" }).click();
  await page.getByText("책갈피와 연결").click();
  await page.getByLabel("WebGPT 세션 URL").fill("https://chatgpt.com/c/vnplayer-smoke");
  await page.getByRole("button", { name: "연결" }).click();
  await expect(page.getByRole("link", { name: "WebGPT 복구" })).toHaveAttribute(
    "href",
    "https://chatgpt.com/c/vnplayer-smoke"
  );

  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("책갈피를 꽂았습니다.")).toBeVisible();

  await page.reload();
  await expect(readingSurface.locator(".prose-block").getByText("The stale connector can only send ordinary paragraphs.")).toBeVisible();
  await expect(readingSurface.getByText("WebGPT 이미지 의뢰서 준비됨")).toHaveCount(0);
  await expect(readingSurface.locator(".cg-prompt")).toHaveCount(0);
  await expect(page.locator(".cg-lane img")).toHaveAttribute("src", importedCgImage.assetUrl);
  await expect(page.getByRole("link", { name: "WebGPT 복구" })).toBeVisible();

  await page.getByRole("button", { name: "세계 목록" }).click();
  await page.getByRole("button", { name: "기존 세계 저장된 세계를 불러와 이야기를 계속한다." }).click();
  const restoredWorld = page.getByRole("button", { name: worldTitle });
  await expect(restoredWorld).toBeVisible();
  await expect(restoredWorld.getByText("WebGPT 복구 가능")).toBeVisible();
  await restoredWorld.click();
  await expect(readingSurface.locator(".prose-block").getByText("The stale connector can only send ordinary paragraphs.")).toBeVisible();

  const rainArchive = await getWorld(page, worldTitle);
  expect(rainArchive.hasWebgptSessionUrl).toBe(true);

  const formBody = await callTool<{ ok: true; form: { responseShape: string; readingPacket: { worldSeedText: string } } }>(
    page,
    "vn_get_current_form",
    {
      worldId: rainArchive.worldId,
      sessionId: rainArchive.latestSessionId
    }
  );
  expect(formBody.form.responseShape).toBe("StoryTurn");
  expect(formBody.form.readingPacket.worldSeedText).toContain(worldTitle);

  await callTool(page, "vn_submit_turn", {
    worldId: rainArchive.worldId,
    sessionId: rainArchive.latestSessionId,
    source: "llm",
    turn: carryoverTurn
  });
  const carryoverState = await callTool<{
    ok: true;
    state: {
      currentCgAsset: { imageUrl: string | null } | null;
      backgroundCgAsset: { imageUrl: string | null } | null;
    };
  }>(page, "vn_get_reader_state", {
    worldId: rainArchive.worldId,
    sessionId: rainArchive.latestSessionId
  });
  expect(carryoverState.state.currentCgAsset).toBeNull();
  expect(carryoverState.state.backgroundCgAsset?.imageUrl).toBe(importedCgImage.assetUrl);
  await page.reload();
  await expect(readingSurface.locator(".prose-block").getByText("no new image-worthy surface")).toBeVisible();
  await expect(page.locator(".cg-lane img")).toHaveAttribute("src", importedCgImage.assetUrl);

  const mcpListResponse = await page.request.post("/mcp", {
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "vn_list_worlds",
        arguments: {}
      }
    }
  });
  await expect(mcpListResponse).toBeOK();
  const mcpList = (await mcpListResponse.json()) as { result: { content: Array<{ type: string; text: string }> } };
  expect(JSON.parse(mcpList.result.content[0].text).worlds.some((world: { title: string }) => world.title === worldTitle)).toBe(true);
});
