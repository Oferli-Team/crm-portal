import { describe, expect, it } from "vitest";
import {
  canManageCompanyProfile,
  assertCanManageCompanyProfile,
  canAccessPaymentDetails,
  assertCanAccessPaymentDetails,
  canManageDomainSettings,
  assertCanManageDomainSettings,
  OrganizationSetupAccessError,
} from "@/lib/organization-setup/authorization";
import type { Role } from "@/generated/prisma/enums";

const ROLES: Role[] = ["OWNER", "ADMIN", "MEMBER"];

describe("canManageCompanyProfile / assertCanManageCompanyProfile", () => {
  it("only OWNER may manage", () => {
    for (const role of ROLES) {
      expect(canManageCompanyProfile(role)).toBe(role === "OWNER");
    }
  });

  it("assert throws OrganizationSetupAccessError for ADMIN/MEMBER, never for OWNER", () => {
    expect(() => assertCanManageCompanyProfile("OWNER")).not.toThrow();
    for (const role of ["ADMIN", "MEMBER"] as Role[]) {
      expect(() => assertCanManageCompanyProfile(role)).toThrow(OrganizationSetupAccessError);
    }
  });
});

describe("canAccessPaymentDetails / assertCanAccessPaymentDetails", () => {
  it("only OWNER may access — stricter than Company Profile, gates read too, not just write", () => {
    for (const role of ROLES) {
      expect(canAccessPaymentDetails(role)).toBe(role === "OWNER");
    }
  });

  it("assert throws for ADMIN/MEMBER, never for OWNER", () => {
    expect(() => assertCanAccessPaymentDetails("OWNER")).not.toThrow();
    for (const role of ["ADMIN", "MEMBER"] as Role[]) {
      expect(() => assertCanAccessPaymentDetails(role)).toThrow(OrganizationSetupAccessError);
    }
  });
});

describe("canManageDomainSettings / assertCanManageDomainSettings", () => {
  it("only OWNER may manage", () => {
    for (const role of ROLES) {
      expect(canManageDomainSettings(role)).toBe(role === "OWNER");
    }
  });

  it("assert throws for ADMIN/MEMBER, never for OWNER", () => {
    expect(() => assertCanManageDomainSettings("OWNER")).not.toThrow();
    for (const role of ["ADMIN", "MEMBER"] as Role[]) {
      expect(() => assertCanManageDomainSettings(role)).toThrow(OrganizationSetupAccessError);
    }
  });
});
