import type { ISdk } from "iii-sdk";
import type { CompressedObservation, Memory, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { VectorIndex } from "../state/vector-index.js";
import type { EmbeddingProvider } from "../types.js";
import { scoreCompression } from "../eval/quality.js";

export interface ProjectStat {
  project: string;
  obsCount: number;
}

export interface DiagnoseReport {
  overview: {
    sessionCount: number;
    totalObservations: number;
    memoryCount: number;
    vectorIndexSize: number;
    vectorCoverage: number;
    embeddingProvider: string | null;
    embeddingDimensions: number | null;
  };
  compressionQuality: {
    average: number;
    median: number;
    lowest: number;
    distribution: Array<{ range: string; count: number }>;
    sampledCount: number;
  };
  projectIsolation: {
    projects: ProjectStat[];
    publicEntryCount: number;
    publicEntryRatio: number;
  };
  recentSamples: Array<{
    title: string;
    qualityScore: number;
    project: string;
    timestamp: string;
    type: string;
  }>;
  health: {
    // "ok" | "warning" | "error"
    status: string;
    warnings: string[];
  };
}

// Assess health thresholds. Customize these values to reflect your own
// experience with recall quality — the defaults are starting points only.
//
// TODO: If you've seen wrong recall, adjust the thresholds here (5-10 lines):
//   - Lower vectorCoverageWarn if your provider is flaky
//   - Lower qualityWarn if you're seeing shallow compressions
//   - Lower publicRatioWarn if cross-project bleed is a concern
function assessHealth(
  report: Omit<DiagnoseReport, "health">,
): { status: string; warnings: string[] } {
  const vectorCoverageWarn = 0.95;
  const qualityWarn = 60;
  const publicRatioWarn = 0.10;

  const warnings: string[] = [];
  const { overview, compressionQuality, projectIsolation } = report;

  if (overview.totalObservations > 0 && overview.vectorCoverage < vectorCoverageWarn) {
    const pct = Math.round(overview.vectorCoverage * 100);
    warnings.push(
      `Vector coverage is ${pct}% (${overview.vectorIndexSize}/${overview.totalObservations}) — check your EMBEDDING_PROVIDER config`,
    );
  }

  if (compressionQuality.sampledCount > 0 && compressionQuality.average < qualityWarn) {
    warnings.push(
      `Avg compression quality is ${compressionQuality.average}/100 — observations may lack facts or narrative`,
    );
  }

  if (
    projectIsolation.publicEntryCount > 0 &&
    projectIsolation.publicEntryRatio > publicRatioWarn
  ) {
    const pct = Math.round(projectIsolation.publicEntryRatio * 100);
    warnings.push(
      `${pct}% of memories have no project scope (${projectIsolation.publicEntryCount} entries) — these appear in ALL project searches`,
    );
  }

  return {
    status: warnings.length === 0 ? "ok" : "warning",
    warnings,
  };
}

export function registerDiagnoseReportFunction(
  sdk: ISdk,
  kv: StateKV,
  vectorIndex: VectorIndex | null,
  embeddingProvider: EmbeddingProvider | null,
): void {
  sdk.registerFunction("mem::diagnose-report", async () => {
    const sessions = await kv.list<Session>(KV.sessions);

    let totalObservations = 0;
    const allObs: CompressedObservation[] = [];
    const projectObsCount = new Map<string, number>();

    for (const session of sessions) {
      const obs = await kv.list<CompressedObservation>(KV.observations(session.id));
      totalObservations += obs.length;
      for (const o of obs) allObs.push(o);
      const project = session.project ?? "(unknown)";
      projectObsCount.set(project, (projectObsCount.get(project) ?? 0) + obs.length);
    }

    const memories = await kv.list<Memory>(KV.memories);
    const publicMemories = memories.filter((m) => m.project === undefined);

    const scores = allObs.map((o) => scoreCompression(o));
    const sorted = [...scores].sort((a, b) => a - b);
    const average = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    const lowest = sorted.length > 0 ? sorted[0] : 0;

    const distribution = [
      { range: "0–49",  count: scores.filter((s) => s < 50).length },
      { range: "50–69", count: scores.filter((s) => s >= 50 && s < 70).length },
      { range: "70–84", count: scores.filter((s) => s >= 70 && s < 85).length },
      { range: "85–100", count: scores.filter((s) => s >= 85).length },
    ];

    const vectorIndexSize = vectorIndex?.size ?? 0;
    const vectorCoverage = totalObservations > 0 ? vectorIndexSize / totalObservations : 0;

    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    const recentSamples = [...allObs]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 5)
      .map((o) => {
        const session = sessionMap.get(o.sessionId);
        return {
          title: o.title,
          qualityScore: scoreCompression(o),
          project: session?.project ?? "(no session)",
          timestamp: o.timestamp,
          type: o.type,
        };
      });

    const projects: ProjectStat[] = Array.from(projectObsCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([project, obsCount]) => ({ project, obsCount }));

    const publicEntryRatio =
      memories.length > 0 ? publicMemories.length / memories.length : 0;

    const partial: Omit<DiagnoseReport, "health"> = {
      overview: {
        sessionCount: sessions.length,
        totalObservations,
        memoryCount: memories.length,
        vectorIndexSize,
        vectorCoverage,
        embeddingProvider: embeddingProvider?.name ?? null,
        embeddingDimensions: embeddingProvider?.dimensions ?? null,
      },
      compressionQuality: {
        average,
        median,
        lowest,
        distribution,
        sampledCount: scores.length,
      },
      projectIsolation: {
        projects,
        publicEntryCount: publicMemories.length,
        publicEntryRatio,
      },
      recentSamples,
    };

    return { ...partial, health: assessHealth(partial) } satisfies DiagnoseReport;
  });
}
