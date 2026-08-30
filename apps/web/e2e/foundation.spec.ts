import { expect, test } from "@playwright/test";

test("shows the foundation dashboard", async ({ page }) => {
  const pulledModelName = "modeldock-e2e:latest";

  await page.request.delete(`/api/models/${encodeURIComponent(pulledModelName)}`);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "AI Server di Flowente" })).toBeVisible();
  await expect(page.getByLabel("ModelDock server")).toContainText("Server");
  await expect(page.getByText("Ollama", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /run diagnostics/i })).toBeVisible();

  await page.getByRole("link", { name: /models/i }).click();
  await expect(page.getByRole("button", { name: /llama3\.1:8b is (not )?loaded in memory/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /llama3\.1:8b is (enabled|disabled)/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Builders (can use|cannot use) llama3\.1:8b/ })).toBeVisible();
  await page.getByLabel("Model name to pull").fill(pulledModelName);
  await expect(page.getByText("Not in your local list.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ollama Search" })).toHaveAttribute("href", "https://ollama.com/search");
  await page.getByRole("button", { name: "Pull" }).click();
  await expect(page.getByLabel("Pull feedback")).toHaveValue(`${pulledModelName}: Pull completed`);
  await expect(page.getByText(pulledModelName).first()).toBeVisible();

  await page.getByRole("link", { name: /devices/i }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await expect(page.getByRole("button", { name: /refresh devices/i })).toBeVisible();
  await expect(page.getByText("Visible devices")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add a new device" })).toBeVisible();
  await expect(page.getByRole("button", { name: /copy invite/i })).toBeVisible();
  await expect(page.getByText("Connection").first()).toBeVisible();
  await expect(page.getByText("Tailscale IP").first()).toBeVisible();

  await page.getByRole("link", { name: /usage/i }).click();
  await expect(page.getByRole("heading", { name: "Chat entry point" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Device → Open WebUI user → Model access" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Configure URL" })).toBeVisible();

  await page.getByRole("link", { name: /onboarding/i }).click();
  await expect(page.getByRole("heading", { name: "Setup server" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invite a client" })).toBeVisible();
  await expect(page.getByLabel("Onboarding message")).toContainText("Fai questi passaggi dal tuo dispositivo");

  await page.getByRole("navigation").getByRole("link", { name: /settings/i }).click();
  await expect(page.getByRole("heading", { name: "How this AI server appears" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat URL and connection" })).toBeVisible();
  await expect(page.getByRole("button", { name: /test connection/i })).toBeVisible();
  await page.getByLabel("Server name").fill("Studio");
  await page.getByLabel("Open WebUI chat URL").fill("http://100.64.0.10:3000");
  await expect(page.getByRole("heading", { name: "AI Server di Studio" })).toBeVisible();
  await expect(page.getByRole("link", { name: /audit/i })).toHaveCount(0);
});
