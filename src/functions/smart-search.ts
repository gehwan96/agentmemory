import type { ISdk } from "iii-sdk";
import type {
  CompactLessonResult,
  CompactSearchResult,
  CompressedObservation,
  HybridSearchResult,
  Lesson,
  Memory,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import { expandProjectAliases } from "../mcp/project-aliases.js";

// Compact mode trims each lesson's content for at-a-glance display. The
// full content is fetched via memory_lesson_recall when the caller needs it.
const LESSON_CONTENT_PREVIEW_CHARS = 240;

export function registerSmartSearchFunction(
  sdk: ISdk,
  kv: StateKV,
  searchFn: (query: string, limit: number) => Promise<HybridSearchResult[]>,
  verboseSearchFn?: (
    query: string,
    limit: number,
  ) => Promise<{
    results: HybridSearchResult[];
    debug: {
      bm25Top5: Array<{ obsId: string; sessionId: string; score: number }>;
      vectorTop5: Array<{ obsId: string; sessionId: string; score: number }>;
      hasEmbeddingProvider: boolean;
      hasVectorIndex: boolean;
      vectorIndexSize: number;
    };
  }>,
): void {
  sdk.registerFunction("mem::smart-search",
    async (data: {
      query?: string;
      expandIds?: Array<string | { obsId: string; sessionId: string }>;
      limit?: number;
      project?: string;
      includeLessons?: boolean;
      verbose?: boolean;
    }) => {

      if (data.expandIds && data.expandIds.length > 0) {
        const raw = data.expandIds.slice(0, 20);
        const items = raw.map((entry) => {
          if (typeof entry === "string") return { obsId: entry, sessionId: undefined as string | undefined };
          if (entry && typeof entry === "object" && typeof (entry as any).obsId === "string") {
            return { obsId: (entry as any).obsId, sessionId: (entry as any).sessionId as string | undefined };
          }
          return null;
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        const expanded: Array<{
          obsId: string;
          sessionId: string;
          observation: CompressedObservation;
        }> = [];

        const results = await Promise.all(
          items.map(({ obsId, sessionId }) =>
            findObservation(kv, obsId, sessionId).then((obs) =>
              obs ? { obsId, sessionId: obs.sessionId, observation: obs } : null,
            ),
          ),
        );
        for (const r of results) {
          if (r) expanded.push(r);
        }

        void recordAccessBatch(
          kv,
          expanded.map((e) => e.observation.id),
        );

        const truncated = data.expandIds.length > raw.length;
        logger.info("Smart search expanded", {
          requested: data.expandIds.length,
          attempted: raw.length,
          returned: expanded.length,
          truncated,
        });
        return { mode: "expanded", results: expanded, truncated };
      }

      if (!data.query || typeof data.query !== "string" || !data.query.trim()) {
        return { mode: "compact", results: [], error: "query is required" };
      }

      const limit = Math.max(1, Math.min(data.limit ?? 20, 100));
      // Cap lesson results at a smaller number than observations: lessons
      // are denser (curated insights) so 10 is usually plenty for a recall.
      const lessonLimit = Math.min(limit, 10);
      const includeLessons = data.includeLessons !== false;
      const verbose = data.verbose === true;

      // Run observation hybrid-search and lesson recall in parallel so the
      // extra lesson lookup adds no wallclock when the underlying calls
      // can overlap. Lesson recall is best-effort: if mem::lesson-recall
      // fails or returns unexpected shape, log + fall back to empty.
      type VerboseDebug = {
        bm25Top5: Array<{ obsId: string; sessionId: string; score: number }>;
        vectorTop5: Array<{ obsId: string; sessionId: string; score: number }>;
        hasEmbeddingProvider: boolean;
        hasVectorIndex: boolean;
        vectorIndexSize: number;
      };

      let verboseDebug: VerboseDebug | undefined;
      let hybridResults: HybridSearchResult[];
      let lessons: Awaited<ReturnType<typeof recallLessons>>;

      if (verbose && verboseSearchFn) {
        const [verboseOut, lessonOut] = await Promise.all([
          verboseSearchFn(data.query, limit),
          includeLessons
            ? recallLessons(sdk, data.query, lessonLimit, data.project)
            : Promise.resolve([]),
        ]);
        hybridResults = verboseOut.results;
        verboseDebug = verboseOut.debug;
        lessons = lessonOut;
      } else {
        [hybridResults, lessons] = await Promise.all([
          searchFn(data.query, limit),
          includeLessons
            ? recallLessons(sdk, data.query, lessonLimit, data.project)
            : Promise.resolve([]),
        ]);
      }

      // Apply project filter if specified
      let filteredResults = hybridResults;
      if (data.project) {
        // Expand to include confirmed aliases only.
        // Pending pairs are intentionally excluded: a pending suggestion is an
        // unverified hypothesis, not a confirmed identity — including them would
        // silently leak memories from sibling repos before a human approves.
        const projectAliasSet = new Set(expandProjectAliases(data.project));
        const filtered = await Promise.all(
          hybridResults.map(async (r) => {
            // mem::remember entries: check Memory.project directly
            const mem = await kv.get<Memory>(KV.memories, r.observation.id).catch(() => null);
            if (mem !== null && mem !== undefined) {
              // undefined project = public legacy layer = passes
              if (mem.project !== undefined && !projectAliasSet.has(mem.project)) return null;
              return r;
            }
            // Regular session observation: check session project
            const session = await kv.get<Session>(KV.sessions, r.sessionId).catch(() => null);
            if (session) {
              if (!projectAliasSet.has(session.project ?? "")) return null;
              return r;
            }
            // No Memory and no Session found: skip
            return null;
          })
        );
        filteredResults = filtered.filter((r): r is HybridSearchResult => r !== null);
      }

      const compact: CompactSearchResult[] = filteredResults.map((r) => ({
        obsId: r.observation.id,
        sessionId: r.sessionId,
        title: r.observation.title,
        type: r.observation.type,
        score: r.combinedScore,
        timestamp: r.observation.timestamp,
      }));

      void recordAccessBatch(
        kv,
        compact.map((r) => r.obsId),
      );

      logger.info("Smart search compact", {
        query: data.query,
        results: compact.length,
        lessons: lessons.length,
        filteredOut: hybridResults.length - filteredResults.length,
      });

      const response: {
        mode: "compact";
        results: CompactSearchResult[];
        lessons?: CompactLessonResult[];
        debug?: typeof verboseDebug & {
          beforeProjectFilter: number;
          afterProjectFilter: number;
        };
      } = { mode: "compact", results: compact };
      if (includeLessons) response.lessons = lessons;
      if (verbose && verboseDebug) {
        response.debug = {
          ...verboseDebug,
          beforeProjectFilter: hybridResults.length,
          afterProjectFilter: filteredResults.length,
        };
      }
      return response;
    },
  );
}

async function recallLessons(
  sdk: ISdk,
  query: string,
  limit: number,
  project?: string,
): Promise<CompactLessonResult[]> {
  try {
    const result = (await sdk.trigger({
      function_id: "mem::lesson-recall",
      payload: { query, limit, project },
    })) as { success?: boolean; lessons?: Array<Lesson & { score?: number }> };
    if (!result?.success || !Array.isArray(result.lessons)) return [];
    return result.lessons.map((l) => ({
      lessonId: l.id,
      content:
        l.content.length > LESSON_CONTENT_PREVIEW_CHARS
          ? l.content.slice(0, LESSON_CONTENT_PREVIEW_CHARS) + "…"
          : l.content,
      confidence: l.confidence,
      score: l.score ?? l.confidence,
      createdAt: l.createdAt,
      project: l.project,
      tags: l.tags ?? [],
    }));
  } catch (err) {
    logger.warn("Smart search: mem::lesson-recall failed; returning empty lesson list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function findObservation(
  kv: StateKV,
  obsId: string,
  sessionIdHint?: string,
): Promise<CompressedObservation | null> {
  if (sessionIdHint) {
    const obs = await kv
      .get<CompressedObservation>(KV.observations(sessionIdHint), obsId)
      .catch(() => null);
    if (obs) return obs;
  }

  const sessions = await kv.list<{ id: string }>(KV.sessions);
  for (let i = 0; i < sessions.length; i += 5) {
    const batch = sessions.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((s) =>
        kv.get<CompressedObservation>(KV.observations(s.id), obsId).catch(() => null),
      ),
    );
    const found = results.find((r) => r !== null);
    if (found) return found;
  }
  return null;
}
