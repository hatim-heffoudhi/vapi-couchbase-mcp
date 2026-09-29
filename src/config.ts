import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPaths = [...new Set([path.resolve(process.cwd(), ".env"), path.join(root, ".env")])];

for (const envPath of envPaths) {
  const result = config({ path: envPath });
  if (!result.parsed) continue;
  for (const [key, value] of Object.entries(result.parsed)) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    const looked = envPaths.filter((p) => existsSync(p)).join(", ") || envPaths.join(", ");
    throw new Error(`Missing ${name}. Add it to .env (looked in ${looked}).`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const STATE_FILE = optional("STATE_FILE", path.join(root, ".vapi-state.json"));

export function normalizeMcpUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
}

export function loadConfig() {
  const token = optional("MCP_SHARED_TOKEN");
  return {
    vapiApiKey: required("VAPI_API_KEY"),
    couchbaseMcpPublicUrl: normalizeMcpUrl(optional("COUCHBASE_MCP_PUBLIC_URL")),
    couchbaseMcpAuthHeader: token ? `Bearer ${token}` : "",
    agentName: optional("AGENT_NAME", "How Couchbase Empowers CS"),
    voiceProvider: optional("AGENT_VOICE_PROVIDER", "cartesia"),
    voiceId: optional("AGENT_VOICE_ID", "a0e99841-438c-4a64-b679-ae501e7d6091"),
    voiceModel: optional("AGENT_VOICE_MODEL", "sonic-3.5"),
    voiceStyle: optional("AGENT_VOICE_STYLE"),
    voiceSpeed: Number(optional("AGENT_VOICE_SPEED", "1")) || 1,
    backgroundSound: optional("AGENT_BACKGROUND_SOUND", "office"),
    model: optional("AGENT_MODEL", "gpt-4o"),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
