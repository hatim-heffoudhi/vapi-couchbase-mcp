import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_FILE } from "./config.js";

export type AgentState = {
  assistantId?: string;
  assistantName?: string;
  toolId?: string;
  sendOtpToolId?: string;
  verifyOtpToolId?: string;
  submitToolId?: string;
  statusToolId?: string;
  cancelToolId?: string;
  mcpUrl?: string;
  updatedAt?: string;
};

export async function readState(): Promise<AgentState> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as AgentState;
  } catch {
    return {};
  }
}

export async function writeState(state: AgentState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(
    STATE_FILE,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}
