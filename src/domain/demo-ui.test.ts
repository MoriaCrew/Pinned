import { describe, expect, it } from "vitest";
import { landingHrefWithDemoNotice, parseDemoNotice, urlWithoutDemoNotice } from "./demo-ui";

describe("demo notice flag (PIN-251)", () => {
  it("round-trips the two notices and rejects anything else", () => {
    expect(landingHrefWithDemoNotice("busy")).toBe("/?demo=busy");
    expect(landingHrefWithDemoNotice("unavailable")).toBe("/?demo=unavailable");
    expect(parseDemoNotice("busy")).toBe("busy");
    expect(parseDemoNotice(["unavailable", "busy"])).toBe("unavailable");
    for (const bad of [undefined, null, "", "1", "BUSY", "deleted", ["nope"], 3, {}]) {
      expect(parseDemoNotice(bad)).toBeNull();
    }
  });

  it("strips only the demo flag from the address, keeping other params and the hash", () => {
    expect(urlWithoutDemoNotice("https://pinneds.com/?demo=busy")).toBe("/");
    expect(urlWithoutDemoNotice("https://pinneds.com/?set=desk&demo=busy#how-it-works")).toBe("/?set=desk#how-it-works");
    expect(urlWithoutDemoNotice("https://pinneds.com/?set=desk")).toBeNull();
    expect(urlWithoutDemoNotice("not a url")).toBeNull();
  });
});
