import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { getPlatformLegalConfig } from "@/lib/legal/platform-config";

export const metadata: Metadata = {
  title: `Terms of Service — ${siteConfig.name}`,
};

export default function TermsOfServicePage() {
  const config = getPlatformLegalConfig();

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <Link
        href="/"
        className="rounded text-sm text-gray-500 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
      >
        ← Back
      </Link>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-gray-500">Effective {config.tosEffectiveDate}</p>

      <div className="mt-10 space-y-10 text-sm leading-relaxed text-gray-700">
        <section>
          <h2 className="text-lg font-semibold text-gray-900">1. Agreement</h2>
          <p className="mt-3">
            These Terms of Service (&ldquo;Terms&rdquo;) govern your use of {siteConfig.name} (the
            &ldquo;Service&rdquo;), operated by {config.legalName} (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By
            creating an account or otherwise using the Service, you agree to these Terms. If you are creating an
            account on behalf of a business, you confirm you have authority to bind that business, and
            &ldquo;you&rdquo; refers to that business as well as you personally.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">2. The Service</h2>
          <p className="mt-3">
            The Service is a client relationship management tool. A staff account belongs to an Organization and
            can be used to manage that Organization&rsquo;s own clients, projects, tasks, invoices, comments, and
            file attachments. An Organization may optionally invite one of its clients to a separate,
            more limited &ldquo;Client Portal&rdquo; account, scoped to that client&rsquo;s own records only.
          </p>
          <p className="mt-3">
            The Service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We do not
            guarantee the Service will be uninterrupted, error-free, or available at all times.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">3. Accounts and invitations</h2>
          <p className="mt-3">
            You are responsible for maintaining the confidentiality of your account credentials and for all
            activity under your account. Staff accounts are provisioned by signing up (which creates a new
            Organization) or by accepting an invitation from an existing Organization; Client Portal accounts are
            created only by accepting an invitation from an Organization you have a client relationship with.
            You must provide accurate information and keep it up to date.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">4. Your data</h2>
          <p className="mt-3">
            As between you and us, an Organization owns the business data (client records, projects, tasks,
            invoices, files, and comments) it enters into the Service. We only process that data to provide the
            Service, as described in our{" "}
            <Link href="/privacy" className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2">
              Privacy Policy
            </Link>
            . You are responsible for the accuracy and legality of the data you enter, including having any
            necessary rights or consents to store your clients&rsquo; information in the Service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">5. Acceptable use</h2>
          <p className="mt-3">You agree not to:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>Use the Service for any unlawful purpose, or to store or transmit content you do not have the right to store or transmit;</li>
            <li>Attempt to access another Organization&rsquo;s data, or bypass or interfere with the Service&rsquo;s access controls or rate limits;</li>
            <li>Reverse engineer, probe, or load-test the Service in a way that degrades it for other users; or</li>
            <li>Use the Service to send unsolicited bulk communications.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">6. Billing</h2>
          <p className="mt-3">
            The Service does not currently charge for access through any live payment processor &mdash;
            organizations today use the Service on a trial or complimentary basis. If paid subscription plans
            are enabled in the future, these Terms will be updated to describe pricing, billing, and cancellation
            terms before any charge is introduced.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">7. Termination</h2>
          <p className="mt-3">
            You may stop using the Service at any time. We do not currently offer a self-service control to
            delete an account or Organization from within the Service; to close an account or request deletion
            of your data, contact us as described in Section 10, and we will process the request manually. We
            may suspend or terminate access to the Service for a violation of these Terms or the Acceptable Use
            section above.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">8. Disclaimers and limitation of liability</h2>
          <p className="mt-3">
            To the maximum extent permitted by law, the Service is provided without warranties of any kind,
            express or implied. We are not liable for indirect, incidental, or consequential damages arising
            from your use of the Service, and our total liability for any claim relating to the Service is
            limited to the amount (if any) you paid us in the 12 months before the claim arose.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">9. Changes to these Terms</h2>
          <p className="mt-3">
            We may update these Terms as the Service changes. If we make a material change, we will update the
            effective date above; continued use of the Service after a change constitutes acceptance of the
            updated Terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900">10. Governing law and contact</h2>
          <p className="mt-3">
            These Terms are governed by the laws applicable in {config.jurisdiction}, without regard to conflict
            of law principles.{" "}
            {config.supportEmail ? (
              <>
                Questions about these Terms can be sent to{" "}
                <a
                  href={`mailto:${config.supportEmail}`}
                  className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  {config.supportEmail}
                </a>
                .
              </>
            ) : (
              <>Questions about these Terms should be directed to your Organization&rsquo;s administrator, or to us through the channel we used to communicate with you.</>
            )}
          </p>
        </section>
      </div>
    </main>
  );
}
