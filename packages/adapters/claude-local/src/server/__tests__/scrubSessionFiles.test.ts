import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertContained,
  encodeClaudeProjectPath,
  resolveClaudeSessionJsonlPath,
  scrubClaudeSessionFiles,
} from "../scrubSessionFiles.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

async function makeClaudeFixture(sessionId = "session-123") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-scrub-"));
  const cwd = path.join(root, "workspace");
  const env = { HOME: root };
  const jsonl = resolveClaudeSessionJsonlPath({ sessionId, cwd, env });
  const sessionDir = path.dirname(jsonl);
  const toolResultsDir = path.join(sessionDir, sessionId, "tool-results");
  await fs.mkdir(toolResultsDir, { recursive: true });
  return { root, cwd, env, jsonl, toolResultsDir, sessionId };
}

describe("scrubClaudeSessionFiles", () => {
  it("redacts string fields inside the exact session JSONL file", async () => {
    const fixture = await makeClaudeFixture();
    await fs.writeFile(fixture.jsonl, `${JSON.stringify({ type: "assistant", message: { text: JWT } })}\n`, "utf-8");

    await scrubClaudeSessionFiles({ ...fixture, onLog: async () => {} });

    const out = await fs.readFile(fixture.jsonl, "utf-8");
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain(JWT);
    expect(JSON.parse(out.trim())).toEqual({ type: "assistant", message: { text: "***REDACTED***" } });
  });

  it("replaces unparseable JSONL lines with valid JSON placeholders", async () => {
    const fixture = await makeClaudeFixture();
    await fs.writeFile(fixture.jsonl, `bad\n${JSON.stringify({ text: JWT })}\n`, "utf-8");

    await scrubClaudeSessionFiles({ ...fixture, onLog: async () => {} });

    const lines = (await fs.readFile(fixture.jsonl, "utf-8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({
      _paperclip_scrub_error: true,
      reason: "json_parse_error",
      line_index: 0,
    });
    expect(lines[1]).toEqual({ text: "***REDACTED***" });
  });

  it("redacts direct tool-result txt files while preserving non-secret text", async () => {
    const fixture = await makeClaudeFixture();
    await fs.writeFile(fixture.jsonl, `${JSON.stringify({ text: "safe" })}\n`, "utf-8");
    const toolResult = path.join(fixture.toolResultsDir, "abc.txt");
    await fs.writeFile(toolResult, `before ${JWT} after`, "utf-8");

    await scrubClaudeSessionFiles({ ...fixture, onLog: async () => {} });

    expect(await fs.readFile(toolResult, "utf-8")).toBe("before ***REDACTED*** after");
  });

  it("does not touch nested tool-result txt files", async () => {
    const fixture = await makeClaudeFixture();
    await fs.writeFile(fixture.jsonl, `${JSON.stringify({ text: "safe" })}\n`, "utf-8");
    const nestedDir = path.join(fixture.toolResultsDir, "nested");
    await fs.mkdir(nestedDir);
    const nested = path.join(nestedDir, "abc.txt");
    await fs.writeFile(nested, JWT, "utf-8");

    await scrubClaudeSessionFiles({ ...fixture, onLog: async () => {} });

    expect(await fs.readFile(nested, "utf-8")).toBe(JWT);
  });

  it("throws for paths outside the session sandbox", () => {
    const root = path.join(os.tmpdir(), "paperclip-claude-project");

    expect(() => assertContained(`${root}_other/session.jsonl`, root)).toThrow(/Path escape/);
  });

  it("throws on unreadable session files", async () => {
    const fixture = await makeClaudeFixture();
    await fs.mkdir(fixture.jsonl);

    await expect(scrubClaudeSessionFiles({ ...fixture, onLog: async () => {} })).rejects.toThrow();
  });

  it("derives the session path from cwd, session id, and Claude config context", () => {
    const env = { CLAUDE_CONFIG_DIR: "/tmp/claude-config" };
    const sessionPath = resolveClaudeSessionJsonlPath({
      sessionId: "abc",
      cwd: "/home/ryan/.paperclip/workspace",
      env,
    });

    expect(sessionPath).toBe(path.join("/tmp/claude-config", "projects", encodeClaudeProjectPath("/home/ryan/.paperclip/workspace"), "abc.jsonl"));
  });
});
