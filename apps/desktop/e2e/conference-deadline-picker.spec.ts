import { expect, test } from "@playwright/test";

const CONFERENCES = `
- title: RTAS
  confs:
    - year: 2027
      timeline:
        - deadline: '2026-11-10 23:59:59'
          comment: 'first round'
      timezone: UTC+0
- title: REFSQ
  confs:
    - year: 2027
      timeline:
        - deadline: '2026-11-12 23:59:59'
          comment: 'second round'
      timezone: UTC+0
- title: RSS
  confs:
    - year: 2027
      timeline:
        - abstract_deadline: '2026-12-01 23:59:59'
          deadline: '2026-12-08 23:59:59'
      timezone: UTC+0
`;

test("exact conferences lead earlier fuzzy matches in the settings picker", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1120, height: 780 });
  await page.clock.setFixedTime(new Date("2026-11-03T00:00:00Z"));
  await page.route("https://ccfddl.com/conference/allconf.yml", (route) =>
    route.fulfill({ body: CONFERENCES, contentType: "text/plain" }),
  );
  await page.goto("/?settings&onboarding-demo");
  await page.getByRole("button", { name: "Cat", exact: true }).click();
  const search = page.getByRole("combobox", {
    name: "Search CCFDDL conferences",
    exact: true,
  });
  const options = page.getByRole("option");
  const ranked = [
    "RSS 2027 (abstract)2026-12-01 23:59:59 UTC+0",
    "RSS 20272026-12-08 23:59:59 UTC+0",
    "RTAS 2027 (first round)2026-11-10 23:59:59 UTC+0",
    "REFSQ 2027 (second round)2026-11-12 23:59:59 UTC+0",
  ];
  for (const query of ["RSS", "RSS 2027"]) {
    await search.fill(query);
    await expect(options).toHaveText(ranked);
    await expect(
      page.getByText("Exact matches", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Fuzzy matches", { exact: true }),
    ).toBeVisible();
    await expect(options.first().locator("mark")).toHaveText(
      query === "RSS" ? ["RSS"] : ["RSS", "2027"],
    );
    await page.screenshot({
      path: testInfo.outputPath(`${query}.png`),
      animations: "disabled",
    });
  }
  await search.fill("rs 2027");
  await expect(page.getByText("Exact matches", { exact: true })).toBeHidden();
  await expect(page.getByText("Fuzzy matches", { exact: true })).toBeVisible();
  await expect(options).toHaveText([
    ranked[2],
    ranked[3],
    ranked[0],
    ranked[1],
  ]);
  await search.fill("RSS 2027");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByRole("listbox")).toBeHidden();
  await search.click();
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await search.fill("RSS 2027");
  await options.nth(1).click();
  await search.click();
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await search.fill("");
  await expect(options).toHaveCount(4);
  await expect(page.getByText("Exact matches", { exact: true })).toBeHidden();
  await expect(page.getByText("Fuzzy matches", { exact: true })).toBeHidden();
});
