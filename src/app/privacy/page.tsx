import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { getPlatformLegalConfig } from "@/lib/legal/platform-config";

export const metadata: Metadata = {
  title: `Privacy Policy — ${siteConfig.name}`,
};

export default function PrivacyPolicyPage() {
  const config = getPlatformLegalConfig();

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <Link
        href="/"
        className="rounded text-sm text-gray-500 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
      >
        ← Back
      </Link>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Effective {config.privacyEffectiveDate}</p>

      <div className="mt-10 space-y-10 text-sm leading-relaxed text-gray-700">
        <section>
          <h2 className="text-lg font-semibold text-gray-900">1. Who this policy covers</h2>
          <p className="mt-3">
            {config.legalName} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) operates {siteConfig.name} (the
            &ldquo;Service&rdquo;), a client relationship management tool that lets a business (an
            &ldquo;Organization&rdquo;) manage its own clients, projects, tasks, invoices, and files, and
            optionally invite its clients to a limited self-service &ldquo;Client Portal&rdquo;.
          </p>
          <p className="mt-3">
            This policy applies to everyone who uses the Service: staff members of an Organization, and Client
            Portal users invited by an Organization. If you are a client of one of our Organizations, that
            Organization &mdash; not us &mdash; controls the business data it enters about you, and is the right
            party to contact about that data. We act as the Organization&rsquo;s data processor for that
            information.
            {config.legalAddress ? ` Our registered address is ${config.legalAddress}.` : ""}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">2. Information we collect</h2>
          <p className="mt-3">We collect the following categories of information:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong className="text-gray-900">Account information.</strong> Name, email address, and password
              for staff and Client Portal accounts. Passwords are handled entirely by our authentication
              provider (Supabase Auth) and stored as a salted hash &mdash; we never see or store a plaintext
              password.
            </li>
            <li>
              <strong className="text-gray-900">Organization and business data.</strong> Information an
              Organization&rsquo;s staff enter into the Service, including organization/business identity details,
              client contacts, projects, tasks, invoices, comments, and activity history.
            </li>
            <li>
              <strong className="text-gray-900">Files you upload.</strong> Documents and other files attached to
              clients, projects, or tasks are stored in our file storage provider (Supabase Storage) under an
              access-controlled path scoped to the uploading Organization.
            </li>
            <li>
              <strong className="text-gray-900">Client Portal data.</strong> If an Organization invites you to
              its Client Portal, we store your name, email address, and the record of which Organization/client
              relationship the invitation was for.
            </li>
            <li>
              <strong className="text-gray-900">Notification preferences.</strong> Which in-app and email
              notifications you have chosen to receive.
            </li>
            <li>
              <strong className="text-gray-900">Technical data.</strong> Requests to the Service are processed
              transiently (e.g. to enforce rate limits that protect against abuse) and are not written to a
              persistent log we control. Our hosting provider (Vercel) may separately retain standard
              infrastructure request logs (such as IP address and timestamps) as part of operating the servers
              the Service runs on.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">3. How we use information</h2>
          <p className="mt-3">We use the information above only to:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>Provide, operate, and maintain the Service, including authenticating you and enforcing access
              controls between Organizations;</li>
            <li>Send transactional email you&rsquo;ve triggered or that is necessary to your account, such as
              invitations, password reset links, and notifications you&rsquo;ve opted into;</li>
            <li>Detect, prevent, and respond to abuse, fraud, and security incidents; and</li>
            <li>Comply with legal obligations.</li>
          </ul>
          <p className="mt-3">
            We do not sell personal information, and we do not use your data for advertising. We do not run any
            third-party analytics or advertising trackers on the Service, and the Service does not set any
            cookies beyond those strictly necessary to keep you signed in and remember your active workspace.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">4. Who we share information with</h2>
          <p className="mt-3">
            We do not sell or rent personal information. We share information only with the service providers
            that operate the infrastructure the Service is built on (our &ldquo;sub-processors&rdquo;), each
            acting under its own data protection terms:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li><strong className="text-gray-900">Supabase</strong> &mdash; database hosting, authentication, and file storage.</li>
            <li><strong className="text-gray-900">Resend</strong> &mdash; delivery of transactional email (invitations, password resets, notifications).</li>
            <li><strong className="text-gray-900">Vercel</strong> &mdash; application hosting and infrastructure.</li>
          </ul>
          <p className="mt-3">
            Staff data you enter about your own clients is visible to other staff members of your Organization
            according to their role, and to any Client Portal user you explicitly invite, scoped to that
            client&rsquo;s own records. We otherwise never share your data across Organizations.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">5. Payments</h2>
          <p className="mt-3">
            The Service does not currently process live payments through any payment provider. No card or bank
            details are collected or stored by us today. If we begin processing real subscription payments in
            the future, this policy will be updated first to name the payment processor and describe what it
            collects, before any such feature is enabled.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">6. Data retention</h2>
          <p className="mt-3">
            We retain account and business data for as long as your account or Organization remains active. Read
            in-app notifications are automatically deleted 90 days after they are marked read; unread
            notifications are kept until you read or otherwise clear them.
          </p>
          <p className="mt-3">
            We do not currently offer a self-service &ldquo;delete my account&rdquo; or &ldquo;export my
            data&rdquo; control inside the Service. To request deletion or a copy of your data, contact us using
            the details in Section 9 and we will handle the request manually.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">7. Security</h2>
          <p className="mt-3">
            Data is encrypted in transit over HTTPS. Access to an Organization&rsquo;s data is restricted to its
            own staff and any Client Portal users it invites; our infrastructure enforces this separation at the
            database and storage layer. No method of transmission or storage is 100% secure, and we cannot
            guarantee absolute security.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">8. Changes to this policy</h2>
          <p className="mt-3">
            We may update this policy as the Service changes. If we make a material change, we will update the
            effective date above; continued use of the Service after a change constitutes acceptance of the
            updated policy.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">9. Contact us</h2>
          <p className="mt-3">
            {config.supportEmail ? (
              <>
                Questions about this policy, or requests to access, correct, or delete your data, can be sent to{" "}
                <a
                  href={`mailto:${config.supportEmail}`}
                  className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  {config.supportEmail}
                </a>
                .
              </>
            ) : (
              <>
                To ask a question about this policy, or to request access to, correction of, or deletion of your
                data, contact your Organization&rsquo;s administrator, or reach us through the channel we used to
                communicate with you.
              </>
            )}{" "}
            This policy is interpreted under the laws applicable in {config.jurisdiction}.
          </p>
        </section>
      </div>
    </main>
  );
}
