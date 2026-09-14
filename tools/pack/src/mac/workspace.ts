import type { ToolPackCache } from "../cache/index.js";
import type { ToolPackConfig } from "../config/index.js";
import { ensureWorkspaceBuildArtifacts } from "../workspace-build.js";
import { runPnpm } from "./commands.js";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function ensureMacWorkspaceBuild(config: ToolPackConfig, cache: ToolPackCache): Promise<void> {
  // Temporary measurement seam, never a normal packaging mode. The authorized
  // experiment verifies each restored component before writing this marker.
  if (process.env.OD_ARCHITECTURE_EXPERIMENT_PREBUILT === "1") {
    if (process.env.GITHUB_REPOSITORY !== "nexu-io/open-design"
      || process.env.GITHUB_REF !== "refs/heads/experiment/architecture-benefit-boundaries"
      || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
      throw new Error("architecture prebuilt input is restricted to its manual experiment branch");
    }
    const marker = JSON.parse(await readFile(join(config.workspaceRoot, ".tmp/architecture-prebuilt.json"), "utf8"));
    if (marker.head !== process.env.GITHUB_SHA || !Array.isArray(marker.outputs) || marker.outputs.length < 5) {
      throw new Error("architecture prebuilt manifest does not match this run");
    }
    for (const output of marker.outputs) {
      if (typeof output !== "string" || !/^(packages|apps)\//.test(output) || output.split("/").includes("..")) {
        throw new Error("invalid architecture prebuilt output");
      }
      await access(join(config.workspaceRoot, output));
    }
    return;
  }
  await ensureWorkspaceBuildArtifacts(
    config,
    cache,
    async (args, extraEnv) => await runPnpm(config, args, extraEnv),
  );
}
