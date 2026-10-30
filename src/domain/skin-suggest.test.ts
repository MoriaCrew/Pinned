import { describe, expect, it } from "vitest";
import en from "../i18n/messages/en.json";
import { SKIN_RULES, foldTitle, newBoardHref, startChoice, suggestSkin, type ReasonKey } from "./skin-suggest";
import { SKINS, isSkinId } from "./skins";

const plain = (skin: string, reason: ReasonKey | null) => ({ skin, reason });

describe("foldTitle (PIN-101)", () => {
  it("lower-cases, strips accents and collapses punctuation", () => {
    expect(foldTitle("  Fête d’été — Léa !! ")).toBe("fete d ete lea");
    expect(foldTitle("Week-end à Paris")).toBe("week end a paris");
    expect(foldTitle("Cempasúchil")).toBe("cempasuchil");
    expect(foldTitle("")).toBe("");
    expect(foldTitle("  ...  ")).toBe("");
  });
});

describe("suggestSkin: default (PIN-101)", () => {
  it("is Paper with no reason when nothing matches", () => {
    for (const title of ["", "   ", "Stuff", "Desk chaos", "Team offsite notes", "东京", "!!!"]) {
      expect(suggestSkin(title)).toEqual(plain("paper", null));
    }
  });

  it("is deterministic", () => {
    expect(suggestSkin("Mia's 7th birthday")).toEqual(suggestSkin("Mia's 7th birthday"));
  });
});

describe("suggestSkin: every rule in English (PIN-101)", () => {
  it.each([
    // party -> zine
    ["Mia's 7th birthday", "zine", "party"],
    ["Sam's BDAY", "zine", "party"],
    ["Sam's b-day", "zine", "party"],
    ["Garden party", "zine", "party"],
    ["Summer parties", "zine", "party"],
    ["Our anniversary", "zine", "party"],
    ["Wedding", "zine", "party"],
    ["Baby shower for Ana", "zine", "party"],
    ["Night out", "zine", "party"],
    ["Sam's 30th", "zine", "party"],
    ["21st", "zine", "party"],
    // trip -> postcard
    ["Trip to the coast", "postcard", "trip"],
    ["Travel diary", "postcard", "trip"],
    ["Holiday 2026", "postcard", "trip"],
    ["Summer vacation", "postcard", "trip"],
    ["Road trip", "postcard", "trip"],
    ["Weekend away", "postcard", "trip"],
    ["Lisbon, June", "postcard", "trip"],
    ["Rome", "postcard", "trip"],
    ["New York", "postcard", "trip"],
    ["NYC", "postcard", "trip"],
    ["London", "postcard", "trip"],
    ["Barcelona", "postcard", "trip"],
    ["Tokyo", "postcard", "trip"],
    ["Japan", "postcard", "trip"],
    ["Italy", "postcard", "trip"],
    ["Spain", "postcard", "trip"],
    ["Mexico", "postcard", "trip"],
    // mood -> darkroom
    ["Moodboard", "darkroom", "mood"],
    ["Mood board for the flat", "darkroom", "mood"],
    ["Inspo", "darkroom", "mood"],
    ["Inspiration", "darkroom", "mood"],
    ["Aesthetic", "darkroom", "mood"],
    ["Good vibes", "darkroom", "mood"],
    ["Night walks", "darkroom", "mood"],
    ["Late shifts", "darkroom", "mood"],
    // home -> cork
    ["Grandma", "cork", "home"],
    ["Grandpa's workshop", "cork", "home"],
    ["Granny's garden", "cork", "home"],
    ["Family", "cork", "home"],
    ["Home", "cork", "home"],
    ["The house", "cork", "home"],
    ["Kitchen chaos", "cork", "home"],
    ["Recipes", "cork", "home"],
    // kids -> fridge
    ["Kids", "fridge", "kids"],
    ["School", "fridge", "kids"],
    ["Breakfast", "fridge", "kids"],
    ["Sunday pancakes", "fridge", "kids"],
    ["Lunch", "fridge", "kids"],
    ["Snacks", "fridge", "kids"],
    ["Fridge", "fridge", "kids"],
    // seasonal -> marigold
    ["Day of the dead", "marigold", "muertos"],
    ["Dia de Muertos", "marigold", "muertos"],
    ["Ofrenda para la abuela", "marigold", "muertos"],
    ["Calavera", "marigold", "muertos"],
    ["Marigold", "marigold", "muertos"],
    ["Cempasúchil", "marigold", "muertos"],
    ["Halloween", "marigold", "season"],
  ] as const)("%s -> %s", (title, skin, reason) => {
    expect(suggestSkin(title)).toEqual(plain(skin, reason));
  });
});

describe("suggestSkin: every rule in French (PIN-101)", () => {
  it.each([
    ["Anniversaire de Léa", "zine", "party"],
    ["Fête des voisins", "zine", "party"],
    ["Soirée crêpes", "zine", "party"],
    ["Mariage", "zine", "party"],
    ["Les 40 ans de Sam", "zine", "party"],
    ["Le 30e de Sam", "zine", "party"],
    ["Voyage", "postcard", "trip"],
    ["Vacances", "postcard", "trip"],
    ["Week-end", "postcard", "trip"],
    ["Weekend", "postcard", "trip"],
    ["Lisbonne en juin", "postcard", "trip"],
    ["Londres", "postcard", "trip"],
    ["Barcelone", "postcard", "trip"],
    ["Japon", "postcard", "trip"],
    ["Italie", "postcard", "trip"],
    ["Espagne", "postcard", "trip"],
    ["Mexique", "postcard", "trip"],
    ["Ambiance", "darkroom", "mood"],
    ["Nuit blanche", "darkroom", "mood"],
    ["Mamie", "cork", "home"],
    ["Papi", "cork", "home"],
    ["Chez Grand-mère", "cork", "home"],
    ["Famille", "cork", "home"],
    ["Maison", "cork", "home"],
    ["Cuisine", "cork", "home"],
    ["Recettes de Mamie", "cork", "home"],
    ["Enfants", "fridge", "kids"],
    ["École", "fridge", "kids"],
    ["Goûter", "fridge", "kids"],
    ["Petit-déj du dimanche", "fridge", "kids"],
    ["Toussaint", "marigold", "season"],
  ] as const)("%s -> %s", (title, skin, reason) => {
    expect(suggestSkin(title)).toEqual(plain(skin, reason));
  });
});

describe("suggestSkin: case, accents, plurals and word boundaries (PIN-101)", () => {
  it("ignores case and accents", () => {
    expect(suggestSkin("ANNIVERSAIRE")).toEqual(suggestSkin("anniversaire"));
    expect(suggestSkin("anniversaire")).toEqual(plain("zine", "party"));
    expect(suggestSkin("SOIREE")).toEqual(plain("zine", "party"));
    expect(suggestSkin("soirée")).toEqual(plain("zine", "party"));
    expect(suggestSkin("DÍA DE LOS MUERTOS")).toEqual(plain("marigold", "muertos"));
    expect(suggestSkin("dia de muertos")).toEqual(plain("marigold", "muertos"));
    expect(suggestSkin("GOÛTER")).toEqual(plain("fridge", "kids"));
    expect(suggestSkin("gouter")).toEqual(plain("fridge", "kids"));
  });

  it("matches plain plurals and the listed irregular ones", () => {
    expect(suggestSkin("Birthdays")).toEqual(plain("zine", "party"));
    expect(suggestSkin("Anniversaries")).toEqual(plain("zine", "party"));
    expect(suggestSkin("Road trips")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("Holidays")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("Lunches")).toEqual(plain("fridge", "kids"));
  });

  it("matches whole words only", () => {
    expect(suggestSkin("Partyless")).toEqual(plain("paper", null));
    expect(suggestSkin("Chrome tabs")).toEqual(plain("paper", null)); // not "rome"
    expect(suggestSkin("Homework")).toEqual(plain("paper", null)); // not "home"
    expect(suggestSkin("Nightmare fuel")).toEqual(plain("paper", null)); // not "night"
    expect(suggestSkin("Latest")).toEqual(plain("paper", null)); // not "late"
    expect(suggestSkin("Tripod")).toEqual(plain("paper", null)); // not "trip"
    expect(suggestSkin("Grandmaster chess")).toEqual(plain("paper", null)); // not "grandma"
    expect(suggestSkin("Cuisinart")).toEqual(plain("paper", null));
  });

  it("matches phrases across spaces, hyphens and punctuation", () => {
    expect(suggestSkin("road-trip")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("Road   trip!")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("new york, new york")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("Week-end à la mer")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("L'anniversaire de Sam")).toEqual(plain("zine", "party"));
    expect(suggestSkin("Mia’s birthday")).toEqual(plain("zine", "party"));
  });

  it("does not take a bare number for an ordinal", () => {
    expect(suggestSkin("Room 30")).toEqual(plain("paper", null));
    expect(suggestSkin("Sam 30th")).toEqual(plain("zine", "party"));
    expect(suggestSkin("30 things")).toEqual(plain("paper", null));
  });
});

describe("suggestSkin: the most specific rule wins (PIN-101)", () => {
  it("puts the seasonal skin before everything", () => {
    expect(suggestSkin("Ofrenda for Grandma's birthday")).toEqual(plain("marigold", "muertos"));
    expect(suggestSkin("Mexico, Day of the Dead")).toEqual(plain("marigold", "muertos"));
    expect(suggestSkin("Halloween party")).toEqual(plain("marigold", "season"));
  });

  it("puts parties before trips, home and kids", () => {
    expect(suggestSkin("Mamie's birthday")).toEqual(plain("zine", "party"));
    expect(suggestSkin("Birthday trip to Rome")).toEqual(plain("zine", "party"));
    expect(suggestSkin("Kids' party")).toEqual(plain("zine", "party"));
    expect(suggestSkin("Anniversaire des enfants")).toEqual(plain("zine", "party"));
  });

  it("puts trips before home and kids", () => {
    expect(suggestSkin("Family trip")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("School trip")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("Vacances en famille")).toEqual(plain("postcard", "trip"));
  });

  it("puts explicit mood words before home and kids, and home before kids", () => {
    expect(suggestSkin("Kitchen inspo")).toEqual(plain("darkroom", "mood"));
    expect(suggestSkin("Inspiration cuisine")).toEqual(plain("darkroom", "mood"));
    expect(suggestSkin("Family breakfast")).toEqual(plain("cork", "home"));
    expect(suggestSkin("Recettes pour les enfants")).toEqual(plain("cork", "home"));
  });

  it("lets time-of-day words lose to a topic, and ordinals lose to everything", () => {
    expect(suggestSkin("Late night pancakes")).toEqual(plain("fridge", "kids"));
    expect(suggestSkin("Night at home")).toEqual(plain("cork", "home"));
    expect(suggestSkin("5th grade trip")).toEqual(plain("postcard", "trip"));
    expect(suggestSkin("5th grade school")).toEqual(plain("fridge", "kids"));
  });
});

describe("skin rules table (PIN-101)", () => {
  it("only names real skins and reasons that have a message", () => {
    for (const rule of SKIN_RULES) {
      expect(isSkinId(rule.skin)).toBe(true);
      expect(`create.reason.${rule.reason}` in en).toBe(true);
    }
  });

  it("keeps every term folded so matching cannot silently miss", () => {
    for (const rule of SKIN_RULES) {
      for (const term of rule.terms) {
        expect(foldTitle(term)).toBe(term);
      }
    }
  });

  it("never lets an earlier rule shadow one of a later rule's own terms", () => {
    for (const rule of SKIN_RULES) {
      for (const term of rule.terms) {
        expect({ term, ...suggestSkin(term) }).toEqual({ term, skin: rule.skin, reason: rule.reason });
      }
    }
  });

  it("can suggest every skin except the Paper default", () => {
    const reachable = new Set(SKIN_RULES.map((rule) => rule.skin));
    for (const skin of SKINS) {
      if (skin.id !== "paper") expect(reachable.has(skin.id)).toBe(true);
    }
  });

  it("suggests Plus skins as Plus (the UI locks them, never forces them)", () => {
    const lisbon = suggestSkin("Lisbon, June");
    expect(SKINS.find((skin) => skin.id === lisbon.skin)?.plus).toBe(true);
    const ofrenda = suggestSkin("Ofrenda para la abuela");
    expect(SKINS.find((skin) => skin.id === ofrenda.skin)?.plus).toBe(true);
    const party = suggestSkin("Mia's 7th birthday");
    expect(SKINS.find((skin) => skin.id === party.skin)?.plus).toBe(false);
  });
});

describe("startChoice and newBoardHref (PIN-101)", () => {
  it("uses a free skin as picked", () => {
    expect(startChoice("zine", "zine")).toEqual({ themeId: "zine", tryOn: null });
    expect(startChoice("cork", "zine")).toEqual({ themeId: "cork", tryOn: null });
    expect(startChoice("paper", "postcard")).toEqual({ themeId: "paper", tryOn: null });
  });

  it("starts a Plus pick on the free suggestion and offers the Plus skin as a try-on", () => {
    expect(startChoice("darkroom", "zine")).toEqual({ themeId: "zine", tryOn: "darkroom" });
    expect(startChoice("postcard", "fridge")).toEqual({ themeId: "fridge", tryOn: "postcard" });
  });

  it("falls back to Paper when the suggestion is a Plus skin too", () => {
    expect(startChoice("postcard", "postcard")).toEqual({ themeId: "paper", tryOn: "postcard" });
    expect(startChoice("marigold", "marigold")).toEqual({ themeId: "paper", tryOn: "marigold" });
    expect(startChoice("darkroom", "postcard")).toEqual({ themeId: "paper", tryOn: "darkroom" });
  });

  it("never stores a Plus skin on a new board", () => {
    for (const picked of SKINS) {
      for (const suggested of SKINS) {
        const choice = startChoice(picked.id, suggested.id);
        expect(SKINS.find((skin) => skin.id === choice.themeId)?.plus).toBe(false);
        expect(choice.tryOn === null).toBe(!picked.plus);
      }
    }
  });

  it("links to the board, with the try-on only when there is one", () => {
    expect(newBoardHref("abc123", null)).toBe("/g/abc123");
    expect(newBoardHref("abc123", "postcard")).toBe("/g/abc123?tryon=postcard");
    expect(newBoardHref("a b/c", null)).toBe("/g/a%20b%2Fc");
  });
});
