import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_ORDER,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_HREF_ALLOWLIST,
  getOnboardingStep,
  isOnboardingStepAvailable,
} from "@/lib/onboarding/steps";

describe("ONBOARDING_STEP_ORDER / ONBOARDING_STEPS — catalog invariants", () => {
  it("every order entry has a matching catalog definition, and vice versa", () => {
    expect(ONBOARDING_STEP_ORDER.length).toBe(Object.keys(ONBOARDING_STEPS).length);
    for (const key of ONBOARDING_STEP_ORDER) {
      expect(ONBOARDING_STEPS[key]).toBeDefined();
      expect(ONBOARDING_STEPS[key].key).toBe(key);
    }
  });

  it("keys are unique", () => {
    expect(new Set(ONBOARDING_STEP_ORDER).size).toBe(ONBOARDING_STEP_ORDER.length);
  });

  it("order values are unique and match each step's own index in ONBOARDING_STEP_ORDER", () => {
    const orders = ONBOARDING_STEP_ORDER.map((key) => ONBOARDING_STEPS[key].order);
    expect(new Set(orders).size).toBe(orders.length);
    ONBOARDING_STEP_ORDER.forEach((key, index) => {
      expect(ONBOARDING_STEPS[key].order).toBe(index);
    });
  });

  it("adopts docs/onboarding-architecture.md §5's decided order, with the Customer Setup Wizard's three steps (Stage 6.2) inserted between WELCOME and CREATE_CLIENT", () => {
    expect(ONBOARDING_STEP_ORDER).toEqual([
      "WELCOME",
      "COMPANY_PROFILE",
      "PAYMENT_DETAILS",
      "DOMAIN_SETUP",
      "CREATE_CLIENT",
      "CREATE_PROJECT",
      "CREATE_TASK",
      "INVITE_TEAMMATE",
      "INVITE_PORTAL_USER",
      "REVIEW_BILLING",
      "FINISH",
    ]);
  });

  it("every dependsOn points at a real step key that appears strictly earlier in the order (no forward references, no cycles)", () => {
    ONBOARDING_STEP_ORDER.forEach((key, index) => {
      const dep = ONBOARDING_STEPS[key].dependsOn;
      if (dep === null) return;
      expect(ONBOARDING_STEPS[dep]).toBeDefined();
      const depIndex = ONBOARDING_STEP_ORDER.indexOf(dep);
      expect(depIndex).toBeGreaterThanOrEqual(0);
      expect(depIndex).toBeLessThan(index);
    });
  });

  it("no step depends on itself", () => {
    for (const key of ONBOARDING_STEP_ORDER) {
      expect(ONBOARDING_STEPS[key].dependsOn).not.toBe(key);
    }
  });

  it("a required step is never also skippable (self-contradictory otherwise)", () => {
    for (const key of ONBOARDING_STEP_ORDER) {
      const def = ONBOARDING_STEPS[key];
      if (def.required) {
        expect(def.skippable).toBe(false);
      }
    }
  });

  it("WELCOME and FINISH are never skippable and never computed from business data", () => {
    expect(ONBOARDING_STEPS.WELCOME.skippable).toBe(false);
    expect(ONBOARDING_STEPS.WELCOME.computed).toBe(false);
    expect(ONBOARDING_STEPS.FINISH.skippable).toBe(false);
    expect(ONBOARDING_STEPS.FINISH.computed).toBe(false);
  });

  it("every non-null targetHref is present in the fixed href allowlist — no invented routes", () => {
    for (const key of ONBOARDING_STEP_ORDER) {
      const href = ONBOARDING_STEPS[key].targetHref;
      if (href === null) continue;
      expect(ONBOARDING_STEP_HREF_ALLOWLIST).toContain(href);
    }
  });

  it("getOnboardingStep returns the exact same object the catalog itself holds", () => {
    expect(getOnboardingStep("CREATE_CLIENT")).toBe(ONBOARDING_STEPS.CREATE_CLIENT);
  });
});

describe("isOnboardingStepAvailable", () => {
  it("is true for every step, including REVIEW_BILLING (Sale-Ready Phase E, E3.3 — billing is merged and live)", () => {
    for (const key of ONBOARDING_STEP_ORDER) {
      expect(isOnboardingStepAvailable(key)).toBe(true);
    }
  });
});
