const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const JWT_TEXT_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const PEM_BLOCK_TEXT_RE = /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g;
const OPENAI_KEY_TEXT_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const GITHUB_TOKEN_TEXT_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const SUPABASE_ACCESS_TOKEN_TEXT_RE = /\bsbp_[A-Za-z0-9_-]{20,}\b/g;
const SUPABASE_SECRET_KEY_TEXT_RE = /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g;
const PAPERCLIP_TOKEN_TEXT_RE =
  /\b[pP][cC][pP]_(?:[A-Za-z0-9-]{20,}|[A-Za-z0-9-]+_[A-Za-z0-9_-]{20,})\b/g;
const BWS_TOKEN_TEXT_RE = /\b[bB][wW][sS]_[A-Za-z0-9._-]{20,}\b/g;
const BWS_ACCESS_TOKEN_TEXT_RE =
  /\b0\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9+/_=-]{16,}(?::[A-Za-z0-9+/_=-]{16,})?\b/gi;
const AUTHORIZATION_BEARER_TEXT_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const ENV_SECRET_ASSIGNMENT_TEXT_RE =
  /(\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*\s*=\s*)[^\s"'`]+/gi;
const JSON_SECRET_FIELD_TEXT_RE =
  /((?:"|')?(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:"|')?\s*:\s*(?:"|'))[^"'`\r\n]+((?:"|'))/gi;
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE =
  /((?:\\")?(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))/gi;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string") {
      const sanitized = redactSensitiveText(value);
      if (sanitized !== value) {
        redacted[key] = sanitized === REDACTED_EVENT_VALUE ? REDACTED_EVENT_VALUE : sanitized;
        continue;
      }
      if (JWT_VALUE_RE.test(value)) {
        redacted[key] = REDACTED_EVENT_VALUE;
        continue;
      }
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(PEM_BLOCK_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(AUTHORIZATION_BEARER_TEXT_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
    .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
    .replace(ENV_SECRET_ASSIGNMENT_TEXT_RE, `$1${REDACTED_EVENT_VALUE}`)
    .replace(OPENAI_KEY_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(GITHUB_TOKEN_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(SUPABASE_ACCESS_TOKEN_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(SUPABASE_SECRET_KEY_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(PAPERCLIP_TOKEN_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(BWS_TOKEN_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(BWS_ACCESS_TOKEN_TEXT_RE, REDACTED_EVENT_VALUE)
    .replace(JWT_TEXT_RE, REDACTED_EVENT_VALUE);
}
