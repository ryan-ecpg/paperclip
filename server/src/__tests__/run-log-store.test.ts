import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_PERSISTED_LOG_CHUNK_CHARS } from "../services/run-log-limits.js";
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

  async function readRawLog(handle: { logRef: string }) {
    if (!tempDir) throw new Error("missing temp run-log base");
    return readFile(path.join(tempDir, handle.logRef), "utf8");
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
    await store.finalize(handle);

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
    await store.finalize(handle);

    const result = await store.read(handle);

    expect(result.content).toContain("***REDACTED***");
    expect(result.content).not.toContain(sbp);
    expect(result.content).not.toContain(sbSecret);
    expect(result.content).not.toContain(ghp);
  });

  it("redacts non-chunk event string fields before persistence", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const syntheticToken = "ws_synthetic-canary-DO-NOT-MATCH-REAL";

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: "x".repeat(MAX_PERSISTED_LOG_CHUNK_CHARS + 1),
      note: `BWS_ACCESS_TOKEN=${syntheticToken}`,
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(syntheticToken);
  });

  it("redacts PEM blocks split across append chunks", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const pemBody = "split-pem-key-material-canary-XYZ";

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: "-----BEGIN RSA PRIVATE KEY-----\nsplit-pem-",
    });
    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:01.000Z",
      chunk: "key-material-canary-XYZ\n-----END RSA PRIVATE KEY-----\n",
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(pemBody);
    expect(content).not.toContain("split-pem-");
    expect(content).not.toContain("key-material-canary-XYZ");
    expect(content).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(content).not.toContain("END RSA PRIVATE KEY");
  });

  it("redacts a PEM block split after a 4097-character chunk", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const pemPrefix = "split-pem-key-material-canary-pos0-";
    const firstChunk = `-----BEGIN RSA PRIVATE KEY-----\n${pemPrefix}`.padEnd(4097, "x");

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: firstChunk,
    });
    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:01.000Z",
      chunk: "\n-----END RSA PRIVATE KEY-----\n",
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(pemPrefix);
    expect(content).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(content).not.toContain("END RSA PRIVATE KEY");
  });

  it("redacts a PEM block whose BEGIN anchor lands after a 100-character preamble in an 8192-character chunk", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const preamble = "p".repeat(100);
    const pemPrefix = "split-pem-key-material-canary-pos100-";
    const firstChunk = `${preamble}-----BEGIN RSA PRIVATE KEY-----\n${pemPrefix}`.padEnd(8192, "x");

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: firstChunk,
    });
    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:01.000Z",
      chunk: "\n-----END RSA PRIVATE KEY-----\n",
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(pemPrefix);
    expect(content).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(content).not.toContain("END RSA PRIVATE KEY");
  });

  it("keeps enough redaction tail for a PEM block split across max-sized persisted chunks", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const pemPrefix = "wide-tail-pem-key-material-canary-";
    const pemBody = `${pemPrefix}${"x".repeat(MAX_PERSISTED_LOG_CHUNK_CHARS)}`;
    const firstChunk = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}`.slice(0, MAX_PERSISTED_LOG_CHUNK_CHARS);

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: firstChunk,
    });
    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:01.000Z",
      chunk: "\n-----END RSA PRIVATE KEY-----\n",
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(pemPrefix);
    expect(content).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(content).not.toContain("END RSA PRIVATE KEY");
  });

  it("redacts a JWT whose anchor lands above the previous 4096-character tail", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const preamble = "p".repeat(100);
    const tokenLabel = " token ";
    const jwtHeader = "eyJhbGciOiJIUzI1NiJ9";
    const firstPayloadChars = 8192 - preamble.length - tokenLabel.length - jwtHeader.length - 1;
    const jwtPayload = `eyJ${"a".repeat(firstPayloadChars + 128)}upstream-sized-jwt-canary`;
    const jwtSignature = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${jwtHeader}.${jwtPayload}.${jwtSignature}`;
    const firstChunk = `${preamble}${tokenLabel}${jwtHeader}.${jwtPayload.slice(0, firstPayloadChars)}`;

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: firstChunk,
    });
    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:01.000Z",
      chunk: `${jwtPayload.slice(firstPayloadChars)}.${jwtSignature}\n`,
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(jwt);
    expect(content).not.toContain(jwtHeader);
    expect(content).not.toContain(jwtPayload);
    expect(content).not.toContain("upstream-sized-jwt-canary");
  });

  it("redacts JWTs split across append chunks", async () => {
    await withTempRunLogBase();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const jwtHeader = "eyJhbGciOiJIUzI1NiJ9";
    const jwtPayload = "eyJzdWIiOiJzcGxpdC1qd3QtY2FuYXJ5In0";
    const jwtSignature = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${jwtHeader}.${jwtPayload}.${jwtSignature}`;

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:00.000Z",
      chunk: `token ${jwtHeader}.${jwtPayload.slice(0, 12)}`,
    });
    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-01T00:00:01.000Z",
      chunk: `${jwtPayload.slice(12)}.${jwtSignature}\n`,
    });
    await store.finalize(handle);

    const content = await readRawLog(handle);

    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain(jwt);
    expect(content).not.toContain(jwtPayload);
    expect(content).not.toContain(jwtPayload.slice(0, 12));
    expect(content).not.toContain(jwtPayload.slice(12));
  });
});
