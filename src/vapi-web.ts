import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, secret: string, expiresIn = 3600): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresIn };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function readAssistantId(): string {
  const fromEnv = env("VAPI_ASSISTANT_ID");
  if (fromEnv) return fromEnv;
  const stateFile = env("STATE_FILE") || ".vapi-state.json";
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { assistantId?: string };
    return state.assistantId?.trim() || "";
  } catch {
    return "";
  }
}

async function readOrgId(assistantId: string, privateKey: string): Promise<string> {
  const fromEnv = env("VAPI_ORG_ID");
  if (fromEnv) return fromEnv;
  const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    headers: { Authorization: `Bearer ${privateKey}` },
  });
  if (!res.ok) return "";
  const data = (await res.json()) as { orgId?: string };
  return data.orgId?.trim() || "";
}

export async function supportCallConfig(origin: string) {
  const assistantId = readAssistantId();
  const publicKey = env("VAPI_PUBLIC_KEY");
  const privateKey = env("VAPI_API_KEY");

  if (!assistantId) {
    return { ready: false, reason: "No assistant yet. Run npm start first." };
  }

  if (publicKey) {
    return { ready: true, assistantId, publicKey };
  }

  if (!privateKey) {
    return { ready: false, reason: "Add VAPI_PUBLIC_KEY or VAPI_API_KEY to start in-page calls." };
  }

  const orgId = await readOrgId(assistantId, privateKey);
  if (!orgId) {
    return { ready: false, reason: "Could not load the Vapi organization for a web call token." };
  }

  const allowedOrigins = [
    origin,
    "http://127.0.0.1:8080",
    "http://localhost:8080",
  ].filter((value, index, all) => value && all.indexOf(value) === index);

  const token = signJwt(
    {
      orgId,
      token: {
        tag: "public",
        restrictions: {
          enabled: true,
          allowedOrigins,
          allowedAssistantIds: [assistantId],
          allowTransientAssistant: false,
        },
      },
    },
    privateKey,
  );

  return { ready: true, assistantId, publicKey: token };
}
