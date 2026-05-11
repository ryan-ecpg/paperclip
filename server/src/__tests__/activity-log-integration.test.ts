import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { logActivity } from "../services/activity-log.js";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity log tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("activity log", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockLoggerWarn.mockClear();
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists activity without a run id when the supplied run was removed", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      action: "test.event",
      entityType: "issue",
      entityId: randomUUID(),
      runId: randomUUID(),
    })).resolves.toBeUndefined();

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBeNull();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, runId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
      runId,
    };
  }

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale route run id",
      status: "in_progress",
      priority: "high",
      createdByUserId: "local-board",
    });
    return { companyId, issueId };
  }

  it("allows route mutations and comments when the caller run id was removed", async () => {
    const { companyId, issueId } = await seedIssue();
    const staleRunId = randomUUID();
    const app = createApp(boardActor(companyId, staleRunId));

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Patched with stale run id" });

    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(patchRes.body.title).toBe("Patched with stale run id");

    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Comment with stale run id" });

    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(commentRes.body.createdByRunId).toBeNull();

    const rows = await db
      .select({
        action: activityLog.action,
        runId: activityLog.runId,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.updated", runId: null }),
        expect.objectContaining({ action: "issue.comment_added", runId: null }),
      ]),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { runId: staleRunId, action: "issue.updated" },
      "activity log referenced missing heartbeat run; retrying without run id",
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { runId: staleRunId, action: "issue.comment_added" },
      "activity log referenced missing heartbeat run; retrying without run id",
    );
  });

  it("allows accepting an interaction and then commenting when the caller run id was removed", async () => {
    const { companyId, issueId } = await seedIssue();
    const interactionId = randomUUID();
    const staleRunId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdByUserId: "local-board",
      payload: {
        version: 1,
        prompt: "Confirm the route keeps working with a stale run id.",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
      },
    });

    const app = createApp(boardActor(companyId, staleRunId));
    const acceptRes = await request(app)
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .send({});

    expect(acceptRes.status, JSON.stringify(acceptRes.body)).toBe(200);
    expect(acceptRes.body.status).toBe("accepted");

    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Follow-up after accepting" });

    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const rows = await db
      .select({
        action: activityLog.action,
        runId: activityLog.runId,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.thread_interaction_accepted", runId: null }),
        expect.objectContaining({ action: "issue.comment_added", runId: null }),
      ]),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { runId: staleRunId, action: "issue.thread_interaction_accepted" },
      "activity log referenced missing heartbeat run; retrying without run id",
    );
  });
});
