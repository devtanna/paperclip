import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { invites, type Db } from "@paperclipai/db";

/** Header the invite landing page sends with its sign-up request. */
export const INVITE_TOKEN_HEADER = "x-paperclip-invite-token";

/** Better Auth's email sign-up endpoint, mounted under `/api/auth`. */
export const EMAIL_SIGN_UP_PATH = "/api/auth/sign-up/email";

const HUMAN_JOIN_TYPES = new Set(["human", "both"]);
const SIGN_UP_INVITE_TYPES = new Set(["company_join", "bootstrap_ceo"]);

type InviteRow = typeof invites.$inferSelect;

// Same scheme as `invites.tokenHash` in routes/access.ts: sha256 hex of the
// raw token. The raw token only ever travels in the invite link.
function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteAllowsHumanSignUp(invite: InviteRow | null, now: Date = new Date()): boolean {
  if (!invite) return false;
  if (invite.revokedAt || invite.acceptedAt) return false;
  if (invite.expiresAt.getTime() <= now.getTime()) return false;
  if (!SIGN_UP_INVITE_TYPES.has(invite.inviteType)) return false;
  return HUMAN_JOIN_TYPES.has(invite.allowedJoinTypes);
}

/**
 * Invite-only sign-up: refuses Better Auth email sign-up unless the request
 * carries a live human invite token. The invite is not consumed here; the
 * normal accept flow on the invite page still does that after sign-in.
 */
export function inviteOnlySignUpGuard(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      const rawToken = req.get(INVITE_TOKEN_HEADER)?.trim();
      const invite = rawToken
        ? await db
            .select()
            .from(invites)
            .where(eq(invites.tokenHash, hashInviteToken(rawToken)))
            .then((rows) => rows[0] ?? null)
        : null;
      if (!inviteAllowsHumanSignUp(invite)) {
        res.status(403).json({
          code: "INVITE_REQUIRED",
          message: "Sign-up is by invitation only. Ask an admin for an invite link.",
        });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
