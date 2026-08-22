"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import { Select } from "@/components/ui/select";
import type { MembershipActionState } from "@/types";

export function RoleSelect({
  membershipId,
  currentRole,
  action,
}: {
  membershipId: string;
  currentRole: "ADMIN" | "MEMBER";
  /** changeRoleAction directly — membershipId is passed explicitly per call, never bound. */
  action: (membershipId: string, newRole: "ADMIN" | "MEMBER") => Promise<MembershipActionState>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const newRole = event.target.value as "ADMIN" | "MEMBER";
    startTransition(async () => {
      const result = await action(membershipId, newRole);
      setError(result.error);
    });
  }

  return (
    <div>
      <Select
        defaultValue={currentRole}
        disabled={isPending}
        onChange={handleChange}
        className="w-28"
        aria-label="Role"
      >
        <option value="MEMBER">Member</option>
        <option value="ADMIN">Admin</option>
      </Select>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
