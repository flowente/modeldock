import { expect, test } from "@playwright/test";

test("shows the foundation app flow", async ({ page }) => {
  const pulledModelName = "modeldock-e2e:latest";

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Configuriamo il tuo AI server locale." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inizia setup" })).toBeVisible();
  await page.getByRole("button", { name: "Inizia setup" }).click();
  await expect(page.getByRole("heading", { name: "Collega il server ai tuoi dispositivi." })).toBeVisible();
  await expect(page.getByText(/non inserire qui email o password/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Avanti" }).first()).toBeEnabled();
  await page.getByRole("button", { name: "Avanti" }).first().click();
  await expect(page.getByRole("heading", { name: "Prepara il tuo server AI." })).toBeVisible();
  await expect(page.getByLabel("Nome amministratore")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Conferma password")).toBeVisible();
  await expect(page.getByText(/password serve solo per creare l'amministratore/i)).toBeVisible();

  await page.goto("/#home");

  await expect(page.getByRole("heading", { name: "AI Server di Flowente" })).toBeVisible();
  await expect(page.getByLabel(/server modeldock|modeldock server/i)).toContainText("Server");
  await expect(page.getByText("Ollama", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: /modelli|models/i }).click();
  await expect(page.getByRole("button", { name: /llama3\.1:8b (is (not )?loaded in memory|è caricato in memoria|non è caricato in memoria)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /llama3\.1:8b (is (enabled|disabled)|è (abilitato|disabilitato))/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /(Builders|Sviluppatori) (can use|cannot use|può usare|non può usare) llama3\.1:8b/ })).toBeVisible();
  await page.getByLabel(/nome del modello da scaricare|model name to pull/i).fill(pulledModelName);
  await expect(page.getByText(/non è presente nella lista locale|not in your local list/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Ollama Search" })).toHaveAttribute("href", "https://ollama.com/search");
  await page.getByRole("button", { name: /scarica|pull/i }).click();
  await expect(page.getByLabel(/esito del download|pull feedback/i)).toHaveValue(new RegExp(`${pulledModelName}: (Download completato|Pull completed)`));
  await expect(page.getByText(pulledModelName).first()).toBeVisible();

  await page.getByRole("link", { name: /dispositivi|devices/i }).click();
  await expect(page.getByRole("heading", { name: /dispositivi|devices/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /aggiorna dispositivi|refresh devices/i })).toBeVisible();
  await expect(page.getByText(/dispositivi visibili|visible devices/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: /aggiungi un dispositivo|add a new device/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /copia invito|copy invite/i })).toBeVisible();
  await expect(page.getByText(/connessione|connection/i).first()).toBeVisible();
  await expect(page.getByText(/ip tailscale|tailscale ip/i).first()).toBeVisible();

  await page.getByRole("link", { name: /utilizzo|usage/i }).click();
  await expect(page.getByRole("heading", { name: /accesso alla chat|chat entry point/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /dispositivo → utente open webui → accesso ai modelli|device → open webui user → model access/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /configura url|configure url/i })).toBeVisible();

  await page.getByRole("link", { name: /setup guidato|onboarding/i }).click();
  await expect(page.getByRole("heading", { name: /configura il server|server setup/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /invita un dispositivo|invite a device/i })).toBeVisible();
  await expect(page.getByLabel(/anteprima dell'invito|invitation preview/i)).toContainText(/ti invito al mio server ai privato|invite you to my private ai server/i);
  await expect(page.getByRole("button", { name: /crea l'invito|create the invitation/i })).toBeVisible();
  // The client column must never send the server owner to a download page.
  await expect(page.getByRole("link", { name: /scarica tailscale|download tailscale/i })).toHaveCount(1);

  await page.getByRole("navigation").getByRole("link", { name: /impostazioni|settings/i }).click();
  await expect(page.getByRole("heading", { name: /come appare questo ai server|how this ai server appears/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /url chat e connessione|chat url and connection/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /test connessione|test connection/i })).toBeVisible();
  await page.getByLabel(/nome server|server name/i).fill("Studio");
  await page.getByLabel(/url della chat open webui|open webui chat url/i).fill("http://100.64.0.10:3000");
  await expect(page.getByRole("heading", { name: "AI Server di Studio" })).toBeVisible();
  await expect(page.getByRole("link", { name: /audit/i })).toHaveCount(0);
});
