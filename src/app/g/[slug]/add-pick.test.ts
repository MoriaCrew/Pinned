import { createElement as h, isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PhotoPick } from "./PhotoPick";

// PhotoPick reads the language with a hook; these tests call it as a plain function.
vi.mock("../../../i18n/client", () => ({ useLocale: () => "en" }));

const noop = () => {};

/** Every <input> in a rendered element tree (PhotoPick is called directly; its language hook is mocked above). */
function findInputs(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findInputs(child, out);
  } else if (isValidElement(node)) {
    if (node.type === "input") out.push(node);
    findInputs((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

type InputProps = { type?: string; accept?: string; capture?: string; multiple?: boolean; onChange?: (event: ChangeEvent<HTMLInputElement>) => void };

describe("add-photo pick actions (PIN-118)", () => {
  it("renders Take photo with the camera capture and Choose photo without it", () => {
    const out = renderToStaticMarkup(h(PhotoPick, { onFiles: noop }));
    // Upload consent (PIN-239) sits at the pick step, before any file is chosen.
    expect(out).toContain("Only upload photos you have permission to share. Anyone with this board&#x27;s link can see them.");
    expect(out).toContain("Take photo");
    expect(out).toContain("Choose photo");
    expect(out.match(/type="file"/g)).toHaveLength(2);
    expect(out.match(/accept="image\/\*"/g)).toHaveLength(2);
    // Capture belongs to the Take photo action only — on the sole
    // input it would force the camera and hide the library.
    expect(out.match(/capture="environment"/g)).toHaveLength(1);
    expect(out.indexOf("Take photo")).toBeLessThan(out.indexOf('capture="environment"'));
    expect(out.indexOf('capture="environment"')).toBeLessThan(out.indexOf("Choose photo"));
  });

  it("wires both inputs to the same handler, which resets the value and forwards every picked file", () => {
    const onFiles = vi.fn();
    const inputs = findInputs(PhotoPick({ onFiles })).map((el) => el.props as InputProps);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].capture).toBe("environment");
    expect(inputs[1].capture).toBeUndefined();
    // Multi-pick belongs to the library only; the camera is one shot.
    expect(inputs[0].multiple).toBeUndefined();
    expect(inputs[1].multiple).toBe(true);
    expect(inputs[0].onChange).toBeTypeOf("function");
    expect(inputs[1].onChange).toBe(inputs[0].onChange);

    const one = { name: "synthetic.jpg" } as File;
    const two = { name: "synthetic-2.jpg" } as File;
    const target = { files: [one, two], value: "synthetic.jpg" };
    inputs[1].onChange?.({ target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([one, two]);
    // Reset so picking the same photos again re-fires onChange.
    expect(target.value).toBe("");
  });

  it("ignores an empty pick (chooser cancelled)", () => {
    const onFiles = vi.fn();
    const [first] = findInputs(PhotoPick({ onFiles })).map((el) => el.props as InputProps);
    const target = { files: [], value: "" };
    first.onChange?.({ target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("review help line words (PIN-126)", () => {
  it("says what a tap does next", async () => {
    const { reviewHelpLine } = await import("./AddSheet");
    expect(reviewHelpLine({ kind: "allKept" }, "en")).toBe("All kept. Tap one to leave it out.");
    expect(reviewHelpLine({ kind: "someLeftOut", n: 1 }, "en")).toBe("1 left out. Tap it to keep it.");
    expect(reviewHelpLine({ kind: "someLeftOut", n: 2 }, "en")).toBe("2 left out. Tap one to keep it.");
    expect(reviewHelpLine({ kind: "noneKept" }, "en")).toBe("None kept. Tap one to keep it.");
  });
});
