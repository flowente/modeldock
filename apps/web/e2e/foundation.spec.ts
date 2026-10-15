import { expect, test } from "@playwright/test";

test("first run: create the administrator, chat with a model, open the server settings", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Configura ModelDock" })).toBeVisible();
  await page.getByLabel("Nome").fill("Prova");
  await page.getByLabel("Email").fill("prova@example.com");
  await page.getByLabel("Password").fill("password-di-prova");
  await page.getByRole("button", { name: "Crea l'account" }).click();

  await expect(page.getByRole("heading", { name: /Ciao Prova, su cosa lavoriamo/ })).toBeVisible();
  await page.getByLabel("Messaggio").fill("Ciao dal test");
  await page.getByLabel("Messaggio").press("Enter");

  // The demo model answers word by word; the conversation then appears in the sidebar.
  await expect(page.getByText(/Fake reply from .* to: Ciao dal test/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Conversazioni" }).getByRole("link", { name: "Ciao dal test" })).toBeVisible();

  await page.goto("/#/impostazioni/server");
  await expect(page.getByRole("heading", { name: "Server", exact: true })).toBeVisible();
  await expect(page.getByText("Ollama (i modelli)")).toBeVisible();
});

test("an old dashboard address lands in the server settings", async ({ page }) => {
  await page.goto("/#home");
  await expect(page).toHaveURL(/#\/impostazioni\/server$/);
});
