import { expect, test } from "@playwright/test";

test("captures a checkout failure that crosses several application layers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Unable to reserve inventory")).toBeVisible();
  await page.evaluate(() => window.__blackboxReport);

  // Deliberately wrong business expectation: this makes Playwright exit 1 so
  // the outer dev-blackbox runner must create a process incident as well.
  await expect(page.getByText(/Order confirmed:/)).toBeVisible({ timeout: 1_000 });
});
