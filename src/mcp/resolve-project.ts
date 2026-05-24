import type { StateKV } from "../state/kv.js";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";

/**
 * Resolves the current project based on sessionId.
 * 
 * @param sessionId - The session ID (optional)
 * @param kv - The StateKV instance
 * @returns The project name, or 'default' if not found
 */
export async function resolveProject(
  sessionId: string | undefined,
  kv: StateKV,
): Promise<string> {
  if (!sessionId) {
    return "default";
  }

  const session = await kv.get<Session>(KV.sessions, sessionId);

  if (!session) {
    return "default";
  }

  return session.project || "default";
}
