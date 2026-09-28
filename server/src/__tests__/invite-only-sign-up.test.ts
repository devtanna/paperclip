import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  EMAIL_SIGN_UP_PATH,
  INVITE_TOKEN_HEADER,
  inviteAllowsHumanSignUp,
  inviteOnlySignUpGuard,
} from "../auth/invite-only-sign-up.js";

const LIVE_TOKEN = "pcp_invite_live";

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    tokenHash: createHash("sha256").update(LIVE_TOKEN).digest("hex"),
    allowedJoinTypes: "human",
    defaultsPayload: null,
    expiresAt: new Date(Date.now() + 60_000),
    invitedByUserId: "user-1",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

// Minimal stand-in for the drizzle select chain: returns the row only when the
// queried token hash matches, the same way the unique index would.
function createDb(row: ReturnType<typeof inviteRow> | null) {
  return {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          const serialized = JSON.stringify(condition, (_key, value) =>
            typeof value === "object" && value !== null && "table" in value ? undefined : value,
          );
          const matches = row !== null && serialized.includes(row.tokenHash);
          return Promise.resolve(matches ? [row] : []);
        },
      }),
    }),
  } as any;
}

function createApp(row: ReturnType<typeof inviteRow> | null) {
  const app = express();
  app.post(EMAIL_SIGN_UP_PATH, inviteOnlySignUpGuard(createDb(row)));
  // Stands in for the Better Auth handler that runs after the guard.
  app.post(EMAIL_SIGN_UP_PATH, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("inviteOnlySignUpGuard", () => {
  it("refuses sign-up without an invite token", async () => {
    const res = await request(createApp(inviteRow())).post(EMAIL_SIGN_UP_PATH).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INVITE_REQUIRED");
  });

  it("refuses sign-up with an unknown token", async () => {
    const res = await request(createApp(inviteRow()))
      .post(EMAIL_SIGN_UP_PATH)
      .set(INVITE_TOKEN_HEADER, "pcp_invite_other")
      .send({});
    expect(res.status).toBe(403);
  });

  it("admits sign-up with a live human invite", async () => {
    const res = await request(createApp(inviteRow()))
      .post(EMAIL_SIGN_UP_PATH)
      .set(INVITE_TOKEN_HEADER, LIVE_TOKEN)
      .send({});
    expect(res.status).toBe(200);
  });
});

describe("inviteAllowsHumanSignUp", () => {
  it("accepts company-join and bootstrap invites that admit humans", () => {
    expect(inviteAllowsHumanSignUp(inviteRow())).toBe(true);
    expect(inviteAllowsHumanSignUp(inviteRow({ allowedJoinTypes: "both" }))).toBe(true);
    expect(inviteAllowsHumanSignUp(inviteRow({ inviteType: "bootstrap_ceo" }))).toBe(true);
  });

  it("rejects missing, spent, expired, revoked, and agent-only invites", () => {
    expect(inviteAllowsHumanSignUp(null)).toBe(false);
    expect(inviteAllowsHumanSignUp(inviteRow({ acceptedAt: new Date() }))).toBe(false);
    expect(inviteAllowsHumanSignUp(inviteRow({ revokedAt: new Date() }))).toBe(false);
    expect(inviteAllowsHumanSignUp(inviteRow({ expiresAt: new Date(Date.now() - 1) }))).toBe(false);
    expect(inviteAllowsHumanSignUp(inviteRow({ allowedJoinTypes: "agent" }))).toBe(false);
    expect(inviteAllowsHumanSignUp(inviteRow({ inviteType: "unknown" }))).toBe(false);
  });
});
