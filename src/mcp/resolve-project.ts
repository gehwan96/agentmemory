import type { StateKV } from "../state/kv.js";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";

/**
 * Resolves the current project based on sessionId.
 * 
 * @param sessionId - The session ID (optional)
 * @param kv - The StateKV instance
 * @returns The project name, or 'default' if not found
 * 
 * Logic:
 * - If sessionId is undefined, return 'default'
 * - Look up the Session in KV.sessions
 * - Return Session.project if found, otherwise 'default'
 */
export async function resolveProject(
  sessionId: string | undefined,
  kv: StateKV,
): Promise<string> {
  // If no sessionId provided, return default
  if (!sessionId) {
    return "default";
  }

  // Try to get the session from KV
  const session = await kv.get<Session>(KV.sessions, sessionId);

  // If session not found, return default; otherwise return session.project
  if (!session) {
    return "default";
  }

  return session.project;
}
