import { describe, expect, it } from "vitest";
import { getPublicOrigin } from "./public-origin";

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("getPublicOrigin", () => {
  it("prefers forwarded proto and host behind App Hosting", () => {
    const req = request("http://0.0.0.0:8080/api/games", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "pinned.example.com",
      host: "0.0.0.0:8080",
    });
    expect(getPublicOrigin(req, "http://localhost:3000")).toBe("https://pinned.example.com");
  });

  it("uses the first forwarded value and ignores unsafe protocols", () => {
    const req = request("http://internal/api/games", {
      "x-forwarded-proto": "javascript, https",
      "x-forwarded-host": "first.example.com, second.example.com",
    });
    expect(getPublicOrigin(req)).toBe("http://first.example.com");
  });

  it("uses a normal Host header locally", () => {
    const req = request("http://localhost:3106/api/games", { host: "localhost:3106" });
    expect(getPublicOrigin(req, "http://localhost:3000")).toBe("http://localhost:3106");
  });

  it("falls back to APP_BASE_URL for an internal-only origin", () => {
    const req = request("http://0.0.0.0:8080/api/games", { host: "0.0.0.0:8080" });
    expect(getPublicOrigin(req, "https://dev.example.com/ignored-path"))
      .toBe("https://dev.example.com");
  });

  it("rejects malformed forwarded hosts", () => {
    const req = request("https://safe.example.com/api/games", {
      "x-forwarded-host": "evil.example/path",
      host: "safe.example.com",
    });
    expect(getPublicOrigin(req)).toBe("https://safe.example.com");
  });
});
