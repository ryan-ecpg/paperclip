import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, redactSensitiveText, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts known token shapes from event payload text fields", () => {
    const barePaperclipToken = `pcp_${"a".repeat(20)}`;
    const underscoredBarePaperclipToken = `pcp_${"a".repeat(10)}_${"b".repeat(10)}`;
    const futurePaperclipToken = `pCp_futurekind_${"b".repeat(20)}`;
    const standardBwsToken = `bWs_${"c".repeat(20)}`;
    const bwsMachineToken = `0.11111111-2222-3333-4444-555555555555.${"A".repeat(40)}`;
    const bwsMachineTokenWithSuffix = `${bwsMachineToken}:${"B".repeat(24)}`;

    const result = redactEventPayload({
      output: `open /invite/${barePaperclipToken} retry /invite/${underscoredBarePaperclipToken}`,
      message: `future ${futurePaperclipToken} standard ${standardBwsToken}`,
      result: `machine ${bwsMachineToken} suffixed ${bwsMachineTokenWithSuffix}`,
      safe: "pcp_short bws_short",
    });

    expect(result).toEqual({
      output: `open /invite/${REDACTED_EVENT_VALUE} retry /invite/${REDACTED_EVENT_VALUE}`,
      message: `future ${REDACTED_EVENT_VALUE} standard ${REDACTED_EVENT_VALUE}`,
      result: `machine ${REDACTED_EVENT_VALUE} suffixed ${REDACTED_EVENT_VALUE}`,
      safe: "pcp_short bws_short",
    });
  });

  it("redacts known token shapes under neutral keys", () => {
    const input = {
      command: `open /invite/pcp_invite_${"a".repeat(20)}`,
      profile: `bWs_${"b".repeat(20)}`,
      access: `0.11111111-2222-3333-4444-555555555555.${"A".repeat(40)}:${"B".repeat(24)}`,
      safe: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.command).toBe(`open /invite/${REDACTED_EVENT_VALUE}`);
    expect(result.profile).toBe(REDACTED_EVENT_VALUE);
    expect(result.access).toBe(REDACTED_EVENT_VALUE);
    expect(result.safe).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const supabaseToken = "sbp_1234567890abcdefghijklmnopqrstuvwxyz";
    const supabaseSecretKey = "sb_secret_1234567890abcdefghijklmnopqrstuvwxyz";
    const anthropicKey = `sk-ant-${"A".repeat(101)}`;
    const privateKeys = [
      [
        "-----BEGIN RSA PRIVATE KEY-----",
        "rsa-private-key-material",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
      "-----BEGIN PRIVATE KEY-----",
      "private-key-material",
      "-----END PRIVATE KEY-----",
      [
        "-----BEGIN EC PRIVATE KEY-----",
        "ec-private-key-material",
        "-----END EC PRIVATE KEY-----",
      ].join("\n"),
    ];
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `GITHUB_TOKEN=${githubToken}`,
      `Supabase access token ${supabaseToken}`,
      `Supabase secret key ${supabaseSecretKey}`,
      `Paperclip token pCp_claim_${"a".repeat(20)}`,
      `Paperclip bare token pcp_${"a".repeat(10)}_${"b".repeat(10)}`,
      `BWS token bWs_${"b".repeat(20)}`,
      `BWS access 0.11111111-2222-3333-4444-555555555555.${"A".repeat(40)}:${"B".repeat(24)}`,
      `Anthropic key ${anthropicKey}`,
      ...privateKeys,
      `session=${jwt}`,
      "Set the SUPABASE_SERVICE_ROLE_KEY env var with the value from BWS",
      "GITHUB_APP_PRIVATE_KEY is documented in the README.",
      "Run BWS_ACCESS_TOKEN through bws.",
      "Non-secrets: ask-question whisk-broom",
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(supabaseToken);
    expect(result).not.toContain(supabaseSecretKey);
    expect(result).not.toContain(`pCp_claim_${"a".repeat(20)}`);
    expect(result).not.toContain(`pcp_${"a".repeat(10)}_${"b".repeat(10)}`);
    expect(result).not.toContain(`bWs_${"b".repeat(20)}`);
    expect(result).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(result).not.toContain(anthropicKey);
    expect(result).not.toContain("rsa-private-key-material");
    expect(result).not.toContain("private-key-material");
    expect(result).not.toContain("ec-private-key-material");
    expect(result).not.toContain(jwt);
    expect(result).toContain("SUPABASE_SERVICE_ROLE_KEY env var");
    expect(result).toContain("GITHUB_APP_PRIVATE_KEY is documented");
    expect(result).toContain("BWS_ACCESS_TOKEN through bws");
    expect(result).toContain("ask-question");
    expect(result).toContain("whisk-broom");
  });
});
