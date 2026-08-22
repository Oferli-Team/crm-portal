import { getCurrentUserOrganization } from "@/lib/current-user";
import { NOTIFICATION_TYPES, getNotificationPreferenceMap } from "@/lib/notifications/preferences";
import { NotificationPreferenceToggle } from "@/components/settings/notification-preference-toggle";
import { ResetPreferencesButton } from "@/components/settings/reset-preferences-button";
import type { NotificationType } from "@/generated/prisma/enums";

const NOTIFICATION_TYPE_LABELS: Record<NotificationType, { title: string; description: string }> = {
  ROLE_CHANGED: {
    title: "Role changed",
    description: "When your role in an organization changes.",
  },
  OWNERSHIP_TRANSFERRED: {
    title: "Ownership transferred",
    description: "When organization ownership is transferred to you.",
  },
  MEMBER_REMOVED: {
    title: "Removed from organization",
    description: "When you're removed from an organization.",
  },
  INVITATION_ACCEPTED: {
    title: "Invitation accepted",
    description: "When someone accepts a staff invitation you sent.",
  },
  PORTAL_INVITATION_ACCEPTED: {
    title: "Client Portal invitation accepted",
    description: "When a client accepts a Client Portal invitation you sent.",
  },
  INVOICE_STATUS_CHANGED: {
    title: "Invoice status changed",
    description: "When an invoice's status changes (Owners/Admins only).",
  },
  // Comments & Mentions Stage 1/2 (docs/comments-architecture.md): the enum
  // value exists ahead of the feature (schema-only stage), but this type
  // stays out of NOTIFICATION_TYPES above until fan-out/UI actually ship in
  // a later stage — this entry only satisfies the exhaustive Record type
  // and is never rendered (the settings page iterates NOTIFICATION_TYPES,
  // not this map's keys).
  MENTIONED: {
    title: "Mentioned in a comment",
    description: "When someone @mentions you in a comment.",
  },
  SUBSCRIPTION_ACTIVATED: {
    title: "Subscription activated",
    description: "When your organization's subscription becomes active (Owners only).",
  },
  PAYMENT_FAILED: {
    title: "Payment failed",
    description: "When a billing payment fails (Owners only).",
  },
  SUBSCRIPTION_CANCELED: {
    title: "Subscription canceled",
    description: "When your organization's subscription is canceled (Owners only).",
  },
  PLAN_CHANGED: {
    title: "Plan changed",
    description: "When your organization's billing plan changes (Owners only).",
  },
};

export default async function NotificationPreferencesPage() {
  const { user } = await getCurrentUserOrganization();
  const preferences = await getNotificationPreferenceMap(user.id);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Notification preferences</h1>
      <p className="mt-1 text-sm text-gray-600">
        Choose what you get notified about, and whether that also reaches your email.
      </p>

      <div className="mt-6 flex justify-end">
        <ResetPreferencesButton />
      </div>

      <div className="mt-2 overflow-hidden overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500 uppercase">
            <tr>
              <th scope="col" className="px-4 py-3">
                Notification type
              </th>
              <th scope="col" className="px-4 py-3 text-center">
                In-app
              </th>
              <th scope="col" className="px-4 py-3 text-center">
                Email
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {NOTIFICATION_TYPES.map((type) => {
              const { title, description } = NOTIFICATION_TYPE_LABELS[type];
              const descId = `${type}-description`;
              const preference = preferences[type];

              return (
                <tr key={type}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{title}</p>
                    <p id={descId} className="mt-0.5 text-xs text-gray-500">
                      {description}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <NotificationPreferenceToggle
                      type={type}
                      channel="inApp"
                      defaultChecked={preference.inAppEnabled}
                      label={`In-app notifications for ${title}`}
                      describedById={descId}
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <NotificationPreferenceToggle
                      type={type}
                      channel="email"
                      defaultChecked={preference.emailEnabled}
                      label={`Email notifications for ${title}`}
                      describedById={descId}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
