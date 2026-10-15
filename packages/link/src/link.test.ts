import { describe, expect, it } from "vitest";
import { buildInviteLink, parseInviteLink } from "./link.ts";

const invite = {
  hosts: [
    { host: "192.168.1.20", port: 4319 },
    { host: "fd00::1", port: 4319 }
  ],
  inviteId: "inv_0123456789abcdef",
  secret: "c2VncmV0by1kaS1wcm92YS0xMjM0",
  fingerprint: "ab".repeat(32)
};

describe("link di invito", () => {
  it("andata e ritorno senza perdere niente", () => {
    expect(parseInviteLink(buildInviteLink(invite))).toEqual(invite);
  });

  it("segreto e impronta stanno dopo il #, mai nella parte che arriva ai server", () => {
    const url = new URL(buildInviteLink(invite));
    expect(`${url.origin}${url.pathname}${url.search}`).toBe("https://192.168.1.20:4319/join");
    expect(url.hash).toContain(invite.secret);
    expect(url.hash).toContain(invite.fingerprint);
  });

  it("accetta l'impronta nel formato con i due punti", () => {
    const link = buildInviteLink({ ...invite, fingerprint: "AB:".repeat(31) + "AB" });
    expect(parseInviteLink(link).fingerprint).toBe(invite.fingerprint);
  });

  it("rifiuta link incompleti o estranei", () => {
    expect(() => parseInviteLink("non è un link")).toThrow(/non sembra/);
    expect(() => parseInviteLink("https://192.168.1.20:4319/join")).toThrow(/Versione/);
    expect(() => parseInviteLink("https://192.168.1.20:4319/join#v=1&i=inv_0123456789abcdef&s=x&fp=corta")).toThrow(/incompleto/);
  });
});
