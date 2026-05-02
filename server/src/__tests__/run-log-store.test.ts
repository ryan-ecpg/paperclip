import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getRunLogStore } from "../services/run-log-store.js";

describe("run log store", () => {
  let tempDir: string | null = null;
  let previousBasePath: string | undefined;

  afterEach(async () => {
    if (previousBasePath === undefined) {
      delete process.env.RUN_LOG_BASE_PATH;
    } else {
      process.env.RUN_LOG_BASE_PATH = previousBasePath;
    }
    previousBasePath = undefined;

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function withTempRunLogBase() {
    previousBasePath = process.env.RUN_LOG_BASE_PATH;
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-store-"));
    process.env.RUN_LOG_BASE_PATH = tempDir;
  }

  it("redacts secret-like values at the file writer boundary", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const anthropicKey = `sk-ant-${"a".repeat(101)}`;

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: [
        `Anthropic key ${anthropicKey}`,
        `payload {"apiKey":"json-secret-value","token":"${jwt}"}`,
      ].join("\n"),
    });

    const result = await store.read(handle);

    expect(result.content).toContain("***REDACTED***");
    expect(result.content).not.toContain(anthropicKey);
    expect(result.content).not.toContain("json-secret-value");
    expect(result.content).not.toContain(jwt);
  });

  it("redacts structured Codex command output before persistence", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const sbp = `sbp_${"a".repeat(24)}`;
    const sbSecret = `sb_secret_${"b".repeat(24)}`;
    const ghp = `ghp_${"c".repeat(36)}`;

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: "command completed",
      item: {
        completed: {
          item: {
            type: "command_execution",
            command: `TOKEN=${sbp} node script.js`,
            aggregated_output: [`supabase ${sbSecret}`, `github ${ghp}`].join("\n"),
          },
        },
      },
    });

    const result = await store.read(handle);

    expect(result.content).toContain("***REDACTED***");
    expect(result.content).not.toContain(sbp);
    expect(result.content).not.toContain(sbSecret);
    expect(result.content).not.toContain(ghp);
  });
});
