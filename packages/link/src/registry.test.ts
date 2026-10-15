import { describe, expect, it } from "vitest";
import { LinkRegistry, MAX_PIN_ATTEMPTS } from "./registry.ts";
import { MemoryStateStore } from "./store.ts";

function setup(start = new Date("2026-10-15T10:00:00Z")) {
  let now = start;
  const store = new MemoryStateStore();
  const registry = new LinkRegistry(store, { now: () => now });
  return { registry, store, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("LinkRegistry", () => {
  it("un invito normale vale una volta sola e il dispositivo entra in attesa", async () => {
    const { registry } = setup();
    const { invite, secret } = await registry.createInvite();
    const joined = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "laptop" });

    expect(joined.device.authorized).toBe(false);
    expect(joined.token).toMatch(/^mdl_/);
    await expect(registry.redeemInvite({ inviteId: invite.id, secret, hostname: "altro" })).rejects.toMatchObject({ code: "invite_used" });
  });

  it("non salva né il segreto né il token in chiaro", async () => {
    const { registry, store } = setup();
    const { invite, secret } = await registry.createInvite();
    const { token } = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "laptop" });

    const saved = JSON.stringify(await store.load());
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(token);
  });

  it("segreto sbagliato e invito inesistente danno lo stesso errore", async () => {
    const { registry } = setup();
    const { invite } = await registry.createInvite();
    await expect(registry.redeemInvite({ inviteId: invite.id, secret: "sbagliato", hostname: "x" })).rejects.toMatchObject({ code: "invite_invalid" });
    await expect(registry.redeemInvite({ inviteId: "inv_0000000000000000", secret: "x", hostname: "x" })).rejects.toMatchObject({ code: "invite_invalid" });
  });

  it("un invito scaduto non vale più", async () => {
    const { registry, advance } = setup();
    const { invite, secret } = await registry.createInvite({ ttlSeconds: 60 });
    advance(61_000);
    await expect(registry.redeemInvite({ inviteId: invite.id, secret, hostname: "x" })).rejects.toMatchObject({ code: "invite_expired" });
  });

  it("con il PIN il link da solo non basta, e dopo troppi errori l'invito si blocca", async () => {
    const { registry } = setup();
    const { invite, secret, pin } = await registry.createInvite({ requirePin: true });
    expect(pin).toMatch(/^\d{6}$/);

    await expect(registry.redeemInvite({ inviteId: invite.id, secret, hostname: "x" })).rejects.toMatchObject({ code: "pin_required" });
    const wrong = pin === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      await expect(registry.redeemInvite({ inviteId: invite.id, secret, hostname: "x", pin: wrong })).rejects.toMatchObject({ code: "pin_invalid" });
    }
    // Ormai anche il PIN giusto non serve più.
    await expect(registry.redeemInvite({ inviteId: invite.id, secret, hostname: "x", pin: pin! })).rejects.toMatchObject({ code: "invite_locked" });
  });

  it("con il PIN giusto si entra", async () => {
    const { registry } = setup();
    const { invite, secret, pin } = await registry.createInvite({ requirePin: true });
    const joined = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "x", pin: pin! });
    expect(joined.device.hostname).toBe("x");
  });

  it("un invito riutilizzabile e preautorizzato fa entrare più dispositivi già approvati", async () => {
    const { registry } = setup();
    const { invite, secret } = await registry.createInvite({ reusable: true, preauthorized: true });
    const first = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "a" });
    const second = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "b" });
    expect(first.device.authorized && second.device.authorized).toBe(true);
  });

  it("il token riconosce il dispositivo; approvazione e blocco cambiano lo stato", async () => {
    const { registry } = setup();
    const { invite, secret } = await registry.createInvite();
    const { device, token } = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "laptop" });

    expect(await registry.authenticate(token)).toMatchObject({ id: device.id, authorized: false });
    await registry.setAuthorization(device.id, true);
    expect(await registry.authenticate(token)).toMatchObject({ authorized: true });
    await registry.setAuthorization(device.id, false);
    expect(await registry.authenticate(token)).toMatchObject({ authorized: false });
    expect(await registry.authenticate("mdl_falso")).toBeUndefined();
  });

  it("pulisce il nome del dispositivo da caratteri di controllo", async () => {
    const { registry } = setup();
    const { invite, secret } = await registry.createInvite();
    const { device } = await registry.redeemInvite({ inviteId: invite.id, secret, hostname: "  lap\u0000top\n " });
    expect(device.hostname).toBe("laptop");
  });

  it("le operazioni in parallelo non si cancellano a vicenda", async () => {
    const { registry } = setup();
    await Promise.all(Array.from({ length: 10 }, () => registry.createInvite()));
    expect(await registry.listInvites()).toHaveLength(10);
  });
});
