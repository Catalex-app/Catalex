import { afterEach, expect, it, vi } from "vitest";
import branding from "../../../../branding.json";

afterEach(() => {
  vi.doUnmock("../../../../branding.json");
  vi.resetModules();
});

it("a display-name change leaves storage and communication identities unchanged", async () => {
  vi.resetModules();
  vi.doMock("../../../../branding.json", () => ({
    default: { ...branding, productName: "Another Display Name" },
  }));
  const renamed = await import("../branding");
  expect(renamed.PRODUCT_NAME).toBe("Another Display Name");
  expect(renamed.PROFILE_DIRECTORY).toBe(branding.profileDirectory);
  expect(renamed.APP_ID).toBe(branding.appId);
  expect(renamed.APP_PROTOCOL).toBe(branding.namespace);
  expect(renamed.ASSET_PROTOCOL).toBe(`${branding.namespace}-asset`);
});
