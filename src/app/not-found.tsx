import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <p className="text-sm font-medium text-gray-500">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
        Page not found
      </h1>
      <p className="mt-2 max-w-sm text-sm text-gray-600">
        The page you&apos;re looking for doesn&apos;t exist, or may belong to
        a different account.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
      >
        Go to dashboard
      </Link>
    </div>
  );
}
