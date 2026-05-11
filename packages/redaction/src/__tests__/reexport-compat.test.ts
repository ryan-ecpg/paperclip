import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSensitiveText as fromPackage } from "../index.js";

describe("server redaction re-export compatibility", () => {
  it("matches shared package output for canonical text vectors", async () => {
    const testDir = path.dirname(new URL(import.meta.url).pathname);
    const serverModule = await import(
      pathToFileURL(path.resolve(testDir, "../../../../server/src/redaction.ts")).href
    ) as typeof import("../index.js");
    const fromServer = serverModule.redactSensitiveText;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const vectors = [
      `session=${jwt}`,
      "OPENAI_API_KEY=sk-example-value",
      "plain text",
    ];

    for (const vector of vectors) {
      expect(fromServer(vector)).toBe(fromPackage(vector));
    }
  });
});
