import { describe, expect, it, vi } from "vitest";

const mockPublishLiveEvent = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

const { logActivity } = await import("../services/activity-log.js");

describe("logActivity", () => {
  it("retries without run id when the activity run foreign key is stale", async () => {
    const staleRunId = "11111111-1111-4111-8111-111111111111";
    const values = vi
      .fn()
      .mockRejectedValueOnce({
        code: "23503",
        constraint: "activity_log_run_id_heartbeat_runs_id_fk",
      })
      .mockResolvedValueOnce(undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
    };

    await logActivity(db as any, {
      companyId: "22222222-2222-4222-8222-222222222222",
      actorType: "agent",
      actorId: "33333333-3333-4333-8333-333333333333",
      action: "issue_comment_created",
      entityType: "issue",
      entityId: "44444444-4444-4444-8444-444444444444",
      agentId: "33333333-3333-4333-8333-333333333333",
      runId: staleRunId,
      details: { body: "created" },
    });

    expect(values).toHaveBeenCalledTimes(2);
    expect(values.mock.calls[0]?.[0]).toMatchObject({ runId: staleRunId });
    expect(values.mock.calls[1]?.[0]).toMatchObject({ runId: null });
    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ runId: null }),
      }),
    );
  });

  it("does not swallow unrelated insert failures", async () => {
    const values = vi.fn().mockRejectedValueOnce(new Error("database unavailable"));
    const db = {
      insert: vi.fn(() => ({ values })),
    };

    await expect(logActivity(db as any, {
      companyId: "22222222-2222-4222-8222-222222222222",
      actorType: "system",
      actorId: "system",
      action: "test.event",
      entityType: "issue",
      entityId: "44444444-4444-4444-8444-444444444444",
      runId: "11111111-1111-4111-8111-111111111111",
    })).rejects.toThrow("database unavailable");
  });
});
