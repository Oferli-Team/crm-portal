// Tracks calls to next/navigation's redirect()/notFound() and next/cache's
// revalidatePath() — all three throw or otherwise require a real Next.js
// request context outside of one. Real Next.js redirect()/notFound() work
// by throwing a special control-flow value that a framework boundary
// catches; tests instead just record the call and return normally, since
// nothing after a redirect()/notFound() call in this app's actions does
// anything worth executing anyway.

export type NavigationCall =
  | { type: "redirect"; url: string }
  | { type: "notFound" }
  | { type: "revalidatePath"; path: string };

let calls: NavigationCall[] = [];

export function mockRedirect(url: string): never {
  calls.push({ type: "redirect", url });
  // Real redirect() never returns — throwing keeps that same contract so
  // a test can assert "code after redirect() never ran" the same way it
  // would against the real implementation.
  throw new RedirectSignal(url);
}

export function mockNotFound(): never {
  calls.push({ type: "notFound" });
  throw new NotFoundSignal();
}

export function mockRevalidatePath(path: string): void {
  // Recorded (unlike a true no-op) so a test can assert a Server Action
  // actually asked to revalidate the right path — this app has no real
  // cache to invalidate in tests, but a missing/wrong revalidatePath call
  // is exactly the kind of silent regression only this call log can catch
  // at the integration layer, before it ever reaches E2E.
  calls.push({ type: "revalidatePath", path });
}

export class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`REDIRECT:${url}`);
  }
}

export class NotFoundSignal extends Error {
  constructor() {
    super("NOT_FOUND");
  }
}

export function getNavigationCalls(): readonly NavigationCall[] {
  return calls;
}

export function resetNavigationMock(): void {
  calls = [];
}
