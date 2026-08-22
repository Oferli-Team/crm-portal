import type { InvitationFormState } from "@/types";

// OWNER is deliberately excluded — invitations can only grant ADMIN or
// MEMBER; ownership isn't transferable through this form.
export const INVITABLE_ROLES = ["ADMIN", "MEMBER"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedInviteInput = {
  email: string;
  role: InvitableRole;
};

export function parseInviteForm(formData: FormData): {
  values: ParsedInviteInput;
  fieldErrors: NonNullable<InvitationFormState["fieldErrors"]>;
} {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const roleRaw = String(formData.get("role") ?? "");

  const fieldErrors: NonNullable<InvitationFormState["fieldErrors"]> = {};

  if (!email) {
    fieldErrors.email = "Email is required.";
  } else if (!EMAIL_PATTERN.test(email)) {
    fieldErrors.email = "Enter a valid email address.";
  }

  const isValidRole = (INVITABLE_ROLES as readonly string[]).includes(roleRaw);
  if (!isValidRole) {
    fieldErrors.role = "Select a valid role.";
  }

  return {
    values: {
      email,
      role: isValidRole ? (roleRaw as InvitableRole) : "MEMBER",
    },
    fieldErrors,
  };
}
