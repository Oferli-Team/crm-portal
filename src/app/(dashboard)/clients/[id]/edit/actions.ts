"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { parseClientForm } from "@/lib/validation/client";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import { diffClientFields, buildClientActivityMetadata } from "@/lib/activity/client-metadata";
import type { ClientFormState } from "@/types";

export async function updateClientAction(
  clientId: string,
  _prevState: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const { values, fieldErrors } = parseClientForm(formData);

  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const { user, organizationId } = await getCurrentUserOrganization();

  try {
    // Update and its (conditional) Activity row are one atomic unit — a
    // failed Activity insert rolls the update back too.
    const outcome = await prisma.$transaction(async (tx) => {
      // Scoped by id + organizationId together — a foreign org's client id
      // simply doesn't match, indistinguishable from a nonexistent one.
      // Also doubles as the "before" snapshot for change-detection below.
      const existing = await tx.client.findFirst({
        where: { id: clientId, organizationId },
      });

      if (!existing) {
        return "not_found" as const;
      }

      const result = await tx.client.updateMany({
        where: { id: clientId, organizationId },
        data: values,
      });

      if (result.count === 0) {
        return "not_found" as const;
      }

      // Only log a real change — a re-submit of identical values (e.g. an
      // accidental double-save) shouldn't add a no-op entry to the log.
      const changedFields = diffClientFields(existing, values);
      if (changedFields.length > 0) {
        await createActivity(tx, {
          organizationId,
          actorId: user.id,
          entityType: "CLIENT",
          entityId: clientId,
          action: "UPDATED",
          metadata: buildClientActivityMetadata(values, user.name, changedFields),
        });
      }

      return "updated" as const;
    });

    if (outcome === "not_found") {
      return { error: "This client could not be found." };
    }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return {
        error: null,
        fieldErrors: { email: "A client with this email already exists." },
      };
    }
    throw err;
  }

  redirect(withToast("/clients", "Client updated"));
}
