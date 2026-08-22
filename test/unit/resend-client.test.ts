import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TEST_MODE is a module-level const computed once at first import (see
// test/unit/recovery-token.test.ts's own identical technique) — set/unset
// process.env.TEST_MODE and vi.resetModules() before each dynamic import
// below so this module's real TEST_MODE branch runs directly, never a
// mock of it.

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
const ORIGINAL_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

function restoreEnv() {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE;
  if (ORIGINAL_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_FROM_EMAIL === undefined) delete process.env.INVITATION_FROM_EMAIL;
  else process.env.INVITATION_FROM_EMAIL = ORIGINAL_FROM_EMAIL;
}

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const BASE_INPUT = {
  to: "client@example.com",
  from: "noreply@example.com",
  subject: "Invoice attached",
  html: "<p>hi</p>",
  text: "hi",
};

function mockResponse(status: number, jsonImpl?: () => Promise<unknown>) {
  const jsonMock = vi.fn(jsonImpl ?? (async () => ({})));
  return { ok: status >= 200 && status < 300, status, json: jsonMock } as unknown as Response;
}

describe("sendEmailViaResend / checkEmailProviderReadiness — TEST_MODE branch", () => {
  beforeEach(() => {
    process.env.TEST_MODE = "1";
    delete process.env.RESEND_API_KEY;
    delete process.env.INVITATION_FROM_EMAIL;
    vi.resetModules();
  });

  it("valid input returns ok:true before any fetch/secret requirement", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("valid optional foundation fields (attachments/idempotencyKey/timeoutMs) do not break TEST_MODE", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({
      ...BASE_INPUT,
      attachments: [{ filename: "invoice.pdf", content: "ZmFrZQ==", content_type: "application/pdf" }],
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a malformed idempotencyKey (CR/LF) fails before the TEST_MODE short-circuit, with zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "bad\r\nkey" });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a malformed timeoutMs (negative) fails before the TEST_MODE short-circuit, with zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, timeoutMs: -1 });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checkEmailProviderReadiness() returns 'ready' without RESEND_API_KEY/INVITATION_FROM_EMAIL configured", async () => {
    const { checkEmailProviderReadiness } = await import("@/lib/email/resend-client");
    expect(checkEmailProviderReadiness()).toBe("ready");
  });
});

describe("sendEmailViaResend — production adapter: existing (pre-Slice-4) behavior unchanged", () => {
  beforeEach(() => {
    delete process.env.TEST_MODE;
    process.env.RESEND_API_KEY = "test-api-key";
    vi.resetModules();
  });

  it("serializes exactly the original four body fields when no new fields are supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body as string)).toEqual({
      from: BASE_INPUT.from,
      to: BASE_INPUT.to,
      subject: BASE_INPUT.subject,
      html: BASE_INPUT.html,
      text: BASE_INPUT.text,
    });
    expect(init.headers).toEqual({ Authorization: "Bearer test-api-key", "Content-Type": "application/json" });
    expect(init.signal).toBeUndefined();
  });

  it("returns not_configured with zero fetch calls when RESEND_API_KEY is absent", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a non-2xx response to provider_error without ever parsing the body", async () => {
    const response = mockResponse(500);
    const fetchSpy = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect((response as unknown as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
  });

  it("maps a thrown fetch failure to network_error", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("simulated DNS failure"));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: false, reason: "network_error" });
  });
});

describe("sendEmailViaResend — production adapter: attachments (Requirement D)", () => {
  beforeEach(() => {
    delete process.env.TEST_MODE;
    process.env.RESEND_API_KEY = "test-api-key";
    vi.resetModules();
  });

  it("serializes attachments exactly as REST JSON with filename/content/content_type", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    await sendEmailViaResend({
      ...BASE_INPUT,
      attachments: [{ filename: "Invoice-2026-001.pdf", content: "ZmFrZS1wZGYtYnl0ZXM=", content_type: "application/pdf" }],
    });

    const init = fetchSpy.mock.calls[0][1];
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.attachments).toEqual([{ filename: "Invoice-2026-001.pdf", content: "ZmFrZS1wZGYtYnl0ZXM=", content_type: "application/pdf" }]);
    expect(typeof parsedBody.attachments[0].content).toBe("string");
    expect(parsedBody.from).toBe(BASE_INPUT.from);
  });

  it("omits content_type on an attachment that doesn't supply it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    await sendEmailViaResend({ ...BASE_INPUT, attachments: [{ filename: "file.pdf", content: "YQ==" }] });

    const init = fetchSpy.mock.calls[0][1];
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.attachments).toEqual([{ filename: "file.pdf", content: "YQ==" }]);
    expect("content_type" in parsedBody.attachments[0]).toBe(false);
  });

  it("omits the attachments key entirely when none are supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    await sendEmailViaResend(BASE_INPUT);

    const init = fetchSpy.mock.calls[0][1];
    const parsedBody = JSON.parse(init.body as string);
    expect("attachments" in parsedBody).toBe(false);
  });
});

describe("sendEmailViaResend — production adapter: Idempotency-Key header (Requirement E)", () => {
  beforeEach(() => {
    delete process.env.TEST_MODE;
    process.env.RESEND_API_KEY = "test-api-key";
    vi.resetModules();
  });

  it("sends exactly one Idempotency-Key header with the exact validated value", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const key = "11111111-1111-4111-8111-111111111111";
    await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: key });

    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers["Idempotency-Key"]).toBe(key);
  });

  it("omits the header entirely when no idempotencyKey is supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    await sendEmailViaResend(BASE_INPUT);

    const init = fetchSpy.mock.calls[0][1];
    expect("Idempotency-Key" in init.headers).toBe(false);
  });

  it("accepts a 1-character key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "a" });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy.mock.calls[0][1].headers["Idempotency-Key"]).toBe("a");
  });

  it("accepts an exactly-256-character key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const key = "a".repeat(256);
    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: key });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy.mock.calls[0][1].headers["Idempotency-Key"]).toBe(key);
  });

  it("rejects a 257-character key before fetch, with zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "a".repeat(257) });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an empty-string key before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "" });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a key containing CR before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "key\rinjected" });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a key containing LF before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "key\ninjected" });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a key containing a header-injection-style second header before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, idempotencyKey: "key\r\nX-Injected: evil" });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendEmailViaResend — production adapter: timeoutMs (Requirement F)", () => {
  beforeEach(() => {
    delete process.env.TEST_MODE;
    process.env.RESEND_API_KEY = "test-api-key";
    vi.resetModules();
  });

  it("rejects timeoutMs of zero before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, timeoutMs: 0 });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-integer timeoutMs before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, timeoutMs: 100.5 });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a timeoutMs above the conservative bound before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, timeoutMs: 30_001 });
    expect(result).toEqual({ ok: false, reason: "provider_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a timeoutMs at exactly the conservative bound and passes an AbortSignal to fetch", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, timeoutMs: 30_000 });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("an abort before any response is received maps to network_error", async () => {
    const fetchSpy = vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend({ ...BASE_INPUT, timeoutMs: 5 });
    expect(result).toEqual({ ok: false, reason: "network_error" });
  });

  it("existing callers that omit timeoutMs never pass a signal to fetch", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    await sendEmailViaResend(BASE_INPUT);
    expect(fetchSpy.mock.calls[0][1].signal).toBeUndefined();
  });
});

describe("sendEmailViaResend — production adapter: 2xx response body parsing (Requirement G)", () => {
  beforeEach(() => {
    delete process.env.TEST_MODE;
    process.env.RESEND_API_KEY = "test-api-key";
    vi.resetModules();
  });

  it("a 2xx with a valid string id returns ok:true with messageId", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => ({ id: "msg_abc123" })));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true, messageId: "msg_abc123" });
  });

  it("a 2xx with no id in the body returns ok:true without messageId", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => ({})));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
    expect("messageId" in result).toBe(false);
  });

  it("a 2xx whose body cannot be parsed as JSON returns ok:true without messageId", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => { throw new Error("invalid json"); }));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
  });

  it("a 2xx with an oversized id (>128 chars) ignores it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => ({ id: "x".repeat(129) })));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
  });

  it("a 2xx with an id at exactly 128 chars is accepted", async () => {
    const id = "x".repeat(128);
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => ({ id })));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true, messageId: id });
  });

  it("a 2xx with a non-string id ignores it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => ({ id: 12345 })));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
  });

  it("a 2xx whose parsed body is an array ignores it entirely", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => (["not", "an", "object"])));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
  });

  it("a 2xx with an empty-string id ignores it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, async () => ({ id: "" })));
    vi.stubGlobal("fetch", fetchSpy);
    const { sendEmailViaResend } = await import("@/lib/email/resend-client");

    const result = await sendEmailViaResend(BASE_INPUT);
    expect(result).toEqual({ ok: true });
  });
});

describe("checkEmailProviderReadiness — production adapter (Requirement C)", () => {
  beforeEach(() => {
    delete process.env.TEST_MODE;
    vi.resetModules();
  });

  it("returns 'ready' when both RESEND_API_KEY and INVITATION_FROM_EMAIL are configured", async () => {
    process.env.RESEND_API_KEY = "real-key";
    process.env.INVITATION_FROM_EMAIL = "billing@example.com";
    const { checkEmailProviderReadiness } = await import("@/lib/email/resend-client");
    expect(checkEmailProviderReadiness()).toBe("ready");
  });

  it("returns 'not_configured' when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.INVITATION_FROM_EMAIL = "billing@example.com";
    const { checkEmailProviderReadiness } = await import("@/lib/email/resend-client");
    expect(checkEmailProviderReadiness()).toBe("not_configured");
  });

  it("returns 'not_configured' when RESEND_API_KEY is whitespace-only", async () => {
    process.env.RESEND_API_KEY = "   ";
    process.env.INVITATION_FROM_EMAIL = "billing@example.com";
    const { checkEmailProviderReadiness } = await import("@/lib/email/resend-client");
    expect(checkEmailProviderReadiness()).toBe("not_configured");
  });

  it("returns 'not_configured' when INVITATION_FROM_EMAIL is missing", async () => {
    process.env.RESEND_API_KEY = "real-key";
    delete process.env.INVITATION_FROM_EMAIL;
    const { checkEmailProviderReadiness } = await import("@/lib/email/resend-client");
    expect(checkEmailProviderReadiness()).toBe("not_configured");
  });

  it("returns 'not_configured' when INVITATION_FROM_EMAIL is whitespace-only", async () => {
    process.env.RESEND_API_KEY = "real-key";
    process.env.INVITATION_FROM_EMAIL = "   ";
    const { checkEmailProviderReadiness } = await import("@/lib/email/resend-client");
    expect(checkEmailProviderReadiness()).toBe("not_configured");
  });
});
