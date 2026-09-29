import { loadConfig, normalizeMcpUrl } from "./config.js";
import { readState, writeState, type AgentState } from "./state.js";
import { buildAssistantPayload, buildOrderbotPrompt, ORDERBOT_FIRST_MESSAGE } from "./templates.js";
import { VapiClient } from "./vapi.js";

function publicOrigin(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

async function upsertTool(
  client: VapiClient,
  existingId: string | undefined,
  create: () => Promise<unknown>,
  patch: Record<string, unknown>,
): Promise<string> {
  if (existingId) {
    try {
      await client.updateTool(existingId, patch);
      return existingId;
    } catch {
      // Saved id may be stale; create a new tool.
    }
  }
  const created = (await create()) as { id: string };
  return created.id;
}

export async function createAgent(opts: { name?: string; mcpUrl?: string; replace?: boolean }) {
  const cfg = loadConfig();
  const mcpUrl = normalizeMcpUrl(opts.mcpUrl || cfg.couchbaseMcpPublicUrl);
  if (!mcpUrl.startsWith("https://")) {
    throw new Error("Pass a public HTTPS MCP URL, e.g. --mcp-url https://xxxx.trycloudflare.com/mcp");
  }
  const origin = publicOrigin(mcpUrl);
  const client = new VapiClient(cfg.vapiApiKey);
  const state = await readState();
  const name = (opts.name || cfg.agentName).slice(0, 40);

  const mcpAuth = cfg.couchbaseMcpAuthHeader
    ? { headers: { Authorization: cfg.couchbaseMcpAuthHeader } }
    : {};

  const toolId = await upsertTool(
    client,
    opts.replace ? state.toolId : undefined,
    () =>
      client.createMcpTool({
        name: "couchbaseMcp",
        serverUrl: mcpUrl,
        authHeader: cfg.couchbaseMcpAuthHeader,
      }),
    {
      server: { url: mcpUrl, timeoutSeconds: 30, ...mcpAuth },
      metadata: { protocol: "shttp" },
    },
  );

  const sendOtpToolId = await upsertTool(
    client,
    opts.replace ? state.sendOtpToolId : undefined,
    () =>
      client.createApiRequestTool({
        name: "send_order_otp",
        description:
          "Send a 6-digit OTP if this live call is not verified yet. A previous call does not count. If already_verified is true, do not mention a code. A new order on this same call does not need a new OTP.",
        method: "POST",
        url: `${origin}/api/otp/send`,
        bodyProperties: {
          order_id: { type: "string", description: "Order id such as ORD-1001 or 1001" },
        },
      }),
    {
      url: `${origin}/api/otp/send`,
      function: {
        name: "send_order_otp",
        description:
          "Send a 6-digit OTP if this live call is not verified yet. A previous call does not count. If already_verified is true, do not mention a code. A new order on this same call does not need a new OTP.",
      },
    },
  );

  const verifyOtpToolId = await upsertTool(
    client,
    opts.replace ? state.verifyOtpToolId : undefined,
    () =>
      client.createApiRequestTool({
        name: "verify_order_otp",
        description:
          "Check the 6-digit code the caller said. After verified is true, this live call is trusted until hangup. Do not send or ask for OTP again for any other order on this call.",
        method: "POST",
        url: `${origin}/api/otp/verify`,
        bodyProperties: {
          order_id: { type: "string", description: "Order id such as ORD-1001" },
          code: { type: "string", description: "Six-digit code spoken by the caller" },
        },
      }),
    {
      url: `${origin}/api/otp/verify`,
      function: {
        name: "verify_order_otp",
        description:
          "Check the 6-digit code the caller said. After verified is true, this live call is trusted until hangup. Do not send or ask for OTP again for any other order on this call.",
      },
    },
  );

  const submitToolId = await upsertTool(
    client,
    opts.replace ? state.submitToolId : undefined,
    () =>
      client.createApiRequestTool({
        name: "submit_delivery_change",
        description:
          "Raise a delivery-date change request for supervisor approval. Does not change the order until approved.",
        method: "POST",
        url: `${origin}/api/requests`,
        bodyProperties: {
          order_id: {
            type: "string",
            description: "Order id such as ORD-1001 or 1001",
          },
          requested_delivery: {
            type: "string",
            description: "Requested delivery date as YYYY-MM-DD",
          },
        },
      }),
    { url: `${origin}/api/requests` },
  );

  const statusToolId = await upsertTool(
    client,
    opts.replace ? state.statusToolId : undefined,
    () =>
      client.createApiRequestTool({
        name: "check_delivery_change",
        description:
          "After cancel_order or submit_delivery_change returns needs_approval, the caller must already have heard that a supervisor has to approve. Call this to see if they accepted. If pending, call again silently. Never say wait a sec.",
        method: "POST",
        url: `${origin}/api/requests/status`,
        timeoutSeconds: 15,
        bodyProperties: {
          request_id: {
            type: "string",
            description: "The request_id returned by submit_delivery_change or cancel_order",
          },
        },
      }),
    {
      url: `${origin}/api/requests/status`,
      timeoutSeconds: 15,
      function: {
        name: "check_delivery_change",
        description:
          "After cancel_order or submit_delivery_change returns needs_approval, the caller must already have heard that a supervisor has to approve. Call this to see if they accepted. If pending, call again silently. Never say wait a sec.",
      },
    },
  );

  const cancelToolId = await upsertTool(
    client,
    opts.replace ? state.cancelToolId : undefined,
    () =>
      client.createApiRequestTool({
        name: "cancel_order",
        description:
          "Cancel after OTP when the caller asks to cancel or says they placed the order by mistake. Processing under 6 hours: cancelled true immediately. Processing older than 6 hours: needs_approval true; you MUST speak spoken_reply (This action needs approval from a supervisor) before polling. Shipped, delivered, and already cancelled cannot be cancelled.",
        method: "POST",
        url: `${origin}/api/orders/cancel`,
        bodyProperties: {
          order_id: { type: "string", description: "Order id such as ORD-1001 or 1001" },
        },
      }),
    {
      url: `${origin}/api/orders/cancel`,
      function: {
        name: "cancel_order",
        description:
          "Cancel after OTP when the caller asks to cancel or says they placed the order by mistake. Processing under 6 hours: cancelled true immediately. Processing older than 6 hours: needs_approval true; you MUST speak spoken_reply (This action needs approval from a supervisor) before polling. Shipped, delivered, and already cancelled cannot be cancelled.",
      },
    },
  );

  const payload = buildAssistantPayload({
    name,
    firstMessage: ORDERBOT_FIRST_MESSAGE,
    systemPrompt: buildOrderbotPrompt(),
    model: cfg.model,
    voiceProvider: cfg.voiceProvider,
    voiceId: cfg.voiceId,
    voiceModel: cfg.voiceModel,
    voiceStyle: cfg.voiceStyle,
    voiceSpeed: cfg.voiceSpeed,
    backgroundSound: cfg.backgroundSound,
    toolIds: [toolId, sendOtpToolId, verifyOtpToolId, submitToolId, statusToolId, cancelToolId],
  });

  let assistant: { id: string; name?: string };
  if (opts.replace && state.assistantId) {
    try {
      assistant = (await client.updateAssistant(state.assistantId, payload)) as {
        id: string;
        name?: string;
      };
    } catch {
      assistant = (await client.createAssistant(payload)) as { id: string; name?: string };
    }
  } else {
    assistant = (await client.createAssistant(payload)) as { id: string; name?: string };
  }

  const nextState: AgentState = {
    assistantId: assistant.id,
    assistantName: assistant.name ?? name,
    toolId,
    sendOtpToolId,
    verifyOtpToolId,
    submitToolId,
    statusToolId,
    cancelToolId,
    mcpUrl,
  };
  await writeState(nextState);

  return {
    ...nextState,
    dashboardUrl: `https://dashboard.vapi.ai/assistants/${assistant.id}`,
    approvalUiUrl: `${origin}/ui`,
    replaced: Boolean(opts.replace && state.assistantId),
  };
}

export async function listAssistants() {
  const cfg = loadConfig();
  const client = new VapiClient(cfg.vapiApiKey);
  const assistants = (await client.listAssistants()) as Array<{
    id: string;
    name?: string;
    createdAt?: string;
  }>;
  return Array.isArray(assistants) ? assistants : [];
}

export async function wipeVapi() {
  const cfg = loadConfig();
  const client = new VapiClient(cfg.vapiApiKey);
  const assistants = await listAssistants();
  let deletedAssistants = 0;
  for (const assistant of assistants) {
    try {
      await client.deleteAssistant(assistant.id);
      deletedAssistants += 1;
    } catch {
      // Already gone.
    }
  }
  const tools = (await client.listTools()) as Array<{ id: string }> | { id: string };
  const toolList = Array.isArray(tools) ? tools : [];
  let deletedTools = 0;
  for (const tool of toolList) {
    if (!tool?.id) continue;
    try {
      await client.deleteTool(tool.id);
      deletedTools += 1;
    } catch {
      // Already gone.
    }
  }
  await writeState({});
  return { deletedAssistants, deletedTools };
}
