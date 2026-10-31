import { describe, expect, it } from "vitest";
import { aiBudgetDenial } from "./ai-budget";

describe("aiBudgetDenial (PIN-180)", () => {
  it("maps the budget and call-limit denials to 'used up' and the switch to 'off'", () => {
    expect(aiBudgetDenial("budget")).toBe("exhausted");
    expect(aiBudgetDenial("call_limit")).toBe("exhausted");
    expect(aiBudgetDenial("budget_off")).toBe("off");
  });

  it("leaves every other code and non-code value alone", () => {
    for (const code of [
      "participant_cap",
      "board_cap",
      "photo_cap",
      "budget_unavailable",
      "credits_pool_empty",
      "no_usable_pins",
      "http_500",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(aiBudgetDenial(code)).toBeNull();
    }
  });
});
