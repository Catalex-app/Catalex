import { expect, test } from "@playwright/test";

test("uses a neutral light Bash tool palette without changing the dark palette", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "light");
  });
  await page.goto("/?debug=agent-activity", {
    waitUntil: "domcontentloaded",
  });

  const widget = page.getByTestId("bash-tool-widget");
  await expect(widget).toBeVisible();
  await widget.getByRole("button").click();
  await expect(widget.locator("pre")).toBeVisible();

  const lightColors = await widget.evaluate((element) => {
    const command = element.querySelector("code");
    const output = element.querySelector("pre");
    return {
      background: getComputedStyle(element).backgroundColor,
      command: command ? getComputedStyle(command).color : "",
      output: output ? getComputedStyle(output).color : "",
    };
  });

  await page.screenshot({
    path: "test-results/bash-tool-light-theme.png",
    fullPage: false,
  });

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);

  const darkColors = await widget.evaluate((element) => {
    const command = element.querySelector("code");
    const output = element.querySelector("pre");
    return {
      background: getComputedStyle(element).backgroundColor,
      command: command ? getComputedStyle(command).color : "",
      output: output ? getComputedStyle(output).color : "",
    };
  });

  expect(lightColors.background).not.toBe(darkColors.background);
  expect(lightColors.command).not.toBe(darkColors.command);
  expect(lightColors.output).not.toBe(darkColors.output);
  expect(darkColors.background).toBe("rgb(30, 30, 46)");

  await page.screenshot({
    path: "test-results/bash-tool-dark-theme.png",
    fullPage: false,
  });
});
