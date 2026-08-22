import { describe, expect, it, vi } from "vitest";
import { sendInvitationEmail } from "@/lib/email/invitations";
import { sendClientPortalInvitationEmail } from "@/lib/email/client-portal-invitations";

// Both send functions accept deps.sendEmail as their sole test seam (same
// pattern as sendPasswordResetEmail) — inject a fake to capture the
// rendered body without a real network call.
function fakeSendEmail() {
  const calls: Array<{ html: string; text: string }> = [];
  const sendEmail = vi.fn(async (params: { html: string; text: string }) => {
    calls.push(params);
    return { ok: true as const };
  });
  return { sendEmail, calls };
}

describe("sendInvitationEmail — includes the shared legal footer", () => {
  it("html and text bodies link to /privacy and /terms", async () => {
    const { sendEmail, calls } = fakeSendEmail();
    process.env.INVITATION_FROM_EMAIL = "Client Portal CRM <invites@example.com>";

    await sendInvitationEmail(
      {
        to: "member@example.com",
        organizationName: "Acme Corp",
        role: "MEMBER",
        invitedByName: "Jane Doe",
        invitationToken: "tok-123",
        expiresAt: new Date("2026-12-31"),
      },
      { sendEmail },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].html).toContain("/privacy");
    expect(calls[0].html).toContain("/terms");
    expect(calls[0].text).toContain("Privacy Policy:");
    expect(calls[0].text).toContain("Terms of Service:");
  });
});

describe("sendClientPortalInvitationEmail — includes the shared legal footer", () => {
  it("html and text bodies link to /privacy and /terms", async () => {
    const { sendEmail, calls } = fakeSendEmail();
    process.env.INVITATION_FROM_EMAIL = "Client Portal CRM <invites@example.com>";

    await sendClientPortalInvitationEmail(
      {
        to: "client@example.com",
        clientName: "Acme Client",
        invitedByName: "Jane Doe",
        invitationToken: "tok-456",
        expiresAt: new Date("2026-12-31"),
      },
      { sendEmail },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].html).toContain("/privacy");
    expect(calls[0].html).toContain("/terms");
    expect(calls[0].text).toContain("Privacy Policy:");
    expect(calls[0].text).toContain("Terms of Service:");
  });
});
