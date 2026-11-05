import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { compileFilter, keySegment, literal } from "../src/odata.js";
import { clearSecrets, redact, registerSecret } from "../src/redact.js";
import { assertReadOnly } from "../src/serviceLayer.js";

afterEach(() => clearSecrets());

describe("odata compiler", () => {
  it("escapes single quotes in literals", () => {
    expect(literal("O'Brien")).toBe("'O''Brien'");
  });

  it("compiles nested and/or filters", () => {
    const f = compileFilter({
      and: [
        { or: [{ field: "CardCode", op: "contains", value: "x'" }, { field: "CardName", op: "contains", value: "x'" }] },
        { field: "CardType", op: "eq", value: "cCustomer" },
      ],
    });
    expect(f).toBe("(contains(CardCode,'x''') or contains(CardName,'x''')) and CardType eq 'cCustomer'");
  });

  it("rejects injected field names", () => {
    expect(() => compileFilter({ field: "CardCode eq 'a' or 1", op: "eq", value: "b" })).toThrow(/Invalid field/);
  });

  it("builds key segments", () => {
    expect(keySegment("BusinessPartners", "C1")).toBe("BusinessPartners('C1')");
    expect(keySegment("Items", "A/B 1")).toBe("Items('A%2FB%201')");
    expect(keySegment("Orders", 12)).toBe("Orders(12)");
  });
});

describe("read-only guard", () => {
  it("allows GET, Login, Logout and SQLQueries List", () => {
    expect(() => assertReadOnly("GET", "BusinessPartners")).not.toThrow();
    expect(() => assertReadOnly("POST", "Login")).not.toThrow();
    expect(() => assertReadOnly("POST", "Logout")).not.toThrow();
    expect(() => assertReadOnly("POST", "SQLQueries('KN_X')/List")).not.toThrow();
  });

  it("blocks every write", () => {
    expect(() => assertReadOnly("POST", "Orders")).toThrow(/read-only/);
    expect(() => assertReadOnly("PATCH", "BusinessPartners('C1')")).toThrow(/read-only/);
    expect(() => assertReadOnly("DELETE", "Items('A1')")).toThrow(/read-only/);
    expect(() => assertReadOnly("PUT", "Items('A1')")).toThrow(/read-only/);
    expect(() => assertReadOnly("POST", "SQLQueries")).toThrow(/read-only/);
    expect(() => assertReadOnly("POST", "Orders(1)/Close")).toThrow(/read-only/);
  });
});

describe("redaction", () => {
  it("scrubs passwords, cookies and registered secrets", () => {
    registerSecret("Sup3rS3cret!");
    const out = redact(
      'login {"CompanyDB":"X","UserName":"manager","Password":"Sup3rS3cret!"} Cookie: B1SESSION=abc-123; ROUTEID=.node1 pw=Sup3rS3cret!',
    );
    expect(out).not.toContain("Sup3rS3cret!");
    expect(out).not.toContain("abc-123");
    expect(out).not.toContain("manager");
    expect(out).toContain("[REDACTED]");
  });
});

describe("config", () => {
  it("mock mode needs no credentials", () => {
    expect(loadConfig({ SAPB1_MOCK: "1" }).mock).toBe(true);
  });

  it("real mode requires all credentials and never echoes the password", () => {
    expect(() => loadConfig({ SAPB1_PASSWORD: "hunter22" })).toThrow(/SAPB1_SERVICE_LAYER_URL/);
    try {
      loadConfig({ SAPB1_PASSWORD: "hunter22" });
    } catch (e) {
      expect(String(e)).not.toContain("hunter22");
    }
  });

  it("refuses plain http unless explicitly allowed", () => {
    const base = { SAPB1_SERVICE_LAYER_URL: "http://h:50001/b1s/v1", SAPB1_COMPANY_DB: "D", SAPB1_USERNAME: "u", SAPB1_PASSWORD: "p1234" };
    expect(() => loadConfig(base)).toThrow(/unencrypted/);
    expect(loadConfig({ ...base, SAPB1_ALLOW_HTTP: "1" }).mock).toBe(false);
  });

  it("caps SAPB1_MAX_ROWS at 500 and TLS checks stay on by default", () => {
    const c = loadConfig({ SAPB1_MOCK: "1", SAPB1_MAX_ROWS: "100000" });
    expect(c.maxRows).toBe(500);
    expect(c.allowSelfSigned).toBe(false);
  });
});
