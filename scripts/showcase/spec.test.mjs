import { describe, expect, it } from "vitest";
import {
  BudgetError,
  JobBudget,
  compileMatch,
  isRelativePhotoName,
  listSetIds,
  parseSpec,
  pickElement,
  planJobs,
  resolveScenePicks,
  validateSpec,
} from "./spec.mjs";
import { catSpec } from "./test-support.mjs";

const withScene = (patch) => {
  const spec = catSpec();
  Object.assign(spec.scenes[0], patch);
  return spec;
};

describe("validateSpec", () => {
  it("accepts the cat set of the spike", () => {
    expect(validateSpec(catSpec())).toEqual([]);
  });

  it("rejects local paths and ways out of the photos folder", () => {
    for (const photo of ["C:/photos/cat.webp", "C:\\cat.webp", "/etc/cat.webp", "../cat.webp", "cat/../../cat.webp", "cat\\ben.webp", "cat/", "cat.txt"]) {
      const spec = catSpec();
      spec.friends[0].photo = photo;
      expect(validateSpec(spec), photo).toEqual([expect.stringContaining("no local paths")]);
    }
    expect(isRelativePhotoName("cat/aye.webp")).toBe(true);
  });

  it("wants made-up first names, each once", () => {
    const spec = { ...catSpec(), scenes: [] };
    spec.friends[1].name = "ben";
    spec.friends[2].name = "Kim Jones";
    expect(validateSpec(spec)).toEqual([
      expect.stringContaining("friends[1]: name must be a made-up first name"),
      expect.stringContaining("friends[2]: name must be a made-up first name"),
    ]);
    spec.friends[1].name = "Ben";
    spec.friends[2].name = "BEN";
    expect(validateSpec(spec)).toEqual([expect.stringContaining("friends[2]: duplicate name")]);
  });

  it("checks the set id, title and counts", () => {
    const spec = { ...catSpec(), scenes: [] };
    spec.id = "Cat Set";
    spec.title = "x".repeat(81);
    spec.friends = spec.friends.slice(0, 1);
    expect(validateSpec(spec)).toEqual([
      expect.stringContaining("id must be lowercase"),
      expect.stringContaining("title must be 1 to 80"),
      expect.stringContaining("friends must list 2 to 6"),
    ]);
  });

  it("limits a scene's prompt, pins and friends", () => {
    expect(validateSpec(withScene({ prompt: "cat beanie sunglasses skateboard ".repeat(20) }))).toEqual([expect.stringContaining("prompt must be 1 to 500")]);

    const five = catSpec().scenes[0].pick;
    expect(validateSpec(withScene({ pick: [...five, { friend: "Kim", match: "board" }] }))).toEqual([expect.stringContaining("pick must list 1 to 4")]);

    expect(
      validateSpec(
        withScene({
          prompt: "The cat in the beanie",
          pick: [
            { friend: "Aye", match: "cat" },
            { friend: "Aye", match: "beanie" },
          ],
          names: undefined,
        }),
      ),
    ).toEqual([expect.stringContaining("at least 2 friends")]);
  });

  it("rejects a pick for an unknown friend or a bad pattern", () => {
    const pick = [...catSpec().scenes[0].pick];
    pick[0] = { friend: "Zed", match: "cat" };
    pick[1] = { friend: "Ben", match: "(beanie" };
    const errors = validateSpec(withScene({ pick, names: undefined }));
    expect(errors).toEqual([expect.stringContaining("friend must be one of the set's friends"), expect.stringContaining("match Invalid regular expression")]);
  });

  it("requires the prompt to name every picked thing", () => {
    const errors = validateSpec(withScene({ prompt: "The orange tabby cat in the green beanie on a skateboard.", names: undefined }));
    expect(errors).toEqual([expect.stringContaining("never names this thing (match /heart|sunglass|glasses/)")]);
  });

  it("requires every item named in the prompt to be a pick (PIN-171)", () => {
    // The prompt names a jacket, but no pick can match one: Muse Image would draw it from the text alone.
    const prompt = `${catSpec().scenes[0].prompt} Add a mustard jacket.`;
    const errors = validateSpec(withScene({ prompt, names: ["cat", "beanie", "jacket"] }));
    expect(errors).toEqual([expect.stringContaining('names: "jacket" has no pick that matches it')]);
    expect(validateSpec(withScene({ names: ["scarf"] }))).toEqual([
      expect.stringContaining('"scarf" is not in the prompt'),
      expect.stringContaining('"scarf" has no pick that matches it'),
    ]);
  });
});

describe("parseSpec and listSetIds", () => {
  const manifest = JSON.stringify({ sets: [catSpec(), { ...catSpec(), id: "second" }] });

  it("reads a single spec", () => {
    expect(parseSpec(JSON.stringify(catSpec())).id).toBe("cat");
    expect(() => parseSpec(JSON.stringify(catSpec()), "dog")).toThrow('spec is for set "cat"');
    expect(listSetIds(JSON.stringify(catSpec()))).toEqual(["cat"]);
  });

  it("picks one set out of a manifest", () => {
    expect(parseSpec(manifest, "second").id).toBe("second");
    expect(listSetIds(manifest)).toEqual(["cat", "second"]);
    expect(() => parseSpec(manifest, "nope")).toThrow('no set "nope" in the manifest (have: cat, second)');
  });

  it("lists every problem when a spec is invalid", () => {
    expect(() => parseSpec("{")).toThrow("not valid JSON");
    expect(() => parseSpec(JSON.stringify({ id: "x" }))).toThrow(/invalid spec:\n- .*\n- /);
  });
});

describe("pickElement", () => {
  const elements = [
    { id: "a1", friend: "Ben", label: "Knitted Hat", description: "a green beanie" },
    { id: "a2", friend: "Ben", label: "Heart Sunglasses", description: "red heart glasses on a hat stand" },
    { id: "a3", friend: "Kim", label: "Skateboard", description: "" },
  ];

  it("matches by pattern, ignoring case", () => {
    expect(pickElement(elements, "Ben", "BEANIE|hat")?.id).toBe("a1");
    expect(pickElement(elements, "Kim", "skate|board")?.id).toBe("a3");
  });

  it("prefers a label match to a description match", () => {
    // "hat" is in the description of the sunglasses too, but the label of a1 matches first.
    expect(pickElement([elements[1], elements[0]], "Ben", "hat")?.id).toBe("a1");
    expect(pickElement(elements, "Ben", "stand")?.id).toBe("a2");
  });

  it("only looks at that friend's things, and skips the ones already used", () => {
    expect(pickElement(elements, "Kim", "hat")).toBeNull();
    expect(pickElement(elements, "Ben", "hat", new Set(["a1"]))?.id).toBe("a2");
  });

  it("refuses a pattern that is empty or too long", () => {
    expect(() => compileMatch("")).toThrow();
    expect(() => compileMatch("a".repeat(121))).toThrow();
  });
});

describe("resolveScenePicks", () => {
  const elements = [
    { id: "e1", friend: "Aye", label: "Ginger Tabby Cat", description: "" },
    { id: "e2", friend: "Ben", label: "Green Beanie", description: "" },
    { id: "e3", friend: "Ben", label: "Red Heart Sunglasses", description: "" },
    { id: "e4", friend: "Kim", label: "Skateboard", description: "" },
  ];

  it("returns the element ids in pick order", () => {
    const { ids, picked, missing } = resolveScenePicks(catSpec().scenes[0], elements);
    expect(ids).toEqual(["e1", "e2", "e3", "e4"]);
    expect(picked[2]).toEqual({ friend: "Ben", label: "Red Heart Sunglasses" });
    expect(missing).toEqual([]);
  });

  it("lists the picks that found nothing", () => {
    const { ids, missing } = resolveScenePicks(catSpec().scenes[0], elements.slice(0, 2));
    expect(ids).toEqual(["e1", "e2"]);
    expect(missing).toEqual([
      { friend: "Ben", match: "heart|sunglass|glasses" },
      { friend: "Kim", match: "skate|board" },
    ]);
  });

  it("never picks one element for two things", () => {
    const scene = { pick: [{ friend: "Ben", match: "green|beanie" }, { friend: "Ben", match: "beanie" }] };
    expect(resolveScenePicks(scene, elements).missing).toEqual([{ friend: "Ben", match: "beanie" }]);
  });
});

describe("job budget", () => {
  it("plans the least and the most jobs a run can start", () => {
    // 3 photos (retried once at worst) + 1 scene (3 tries at worst)
    expect(planJobs([catSpec()], { sceneTries: 3 })).toEqual({ min: 4, max: 9 });
    expect(planJobs([catSpec(), catSpec()], { sceneTries: 2 })).toEqual({ min: 8, max: 16 });
  });

  it("stops before the job over the cap", () => {
    const budget = new JobBudget(2);
    budget.spend("a");
    budget.spend("b");
    expect(() => budget.spend("scene c1")).toThrow(BudgetError);
    expect(() => budget.spend("scene c1")).toThrow("job cap of 2 reached before scene c1");
    expect(budget.used).toBe(2);
    expect(() => new JobBudget(0)).toThrow(RangeError);
  });
});
