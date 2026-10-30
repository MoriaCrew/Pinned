import { createElement as h, isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PhotoPick } from "./PhotoPick";

const noop = () => {};

/** Every <input> in a rendered element tree (PhotoPick is hook-free, so it can be called directly). */
function findInputs(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findInputs(child, out);
  } else if (isValidElement(node)) {
    if (node.type === "input") out.push(node);
    findInputs((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

type InputProps = { type?: string; accept?: string; capture?: string; onChange?: (event: ChangeEvent<HTMLInputElement>) => void };

describe("add-photo pick actions (PIN-118)", () => {
  it("renders Take photo with the camera capture and Choose photo without it", () => {
    const out = renderToStaticMarkup(h(PhotoPick, { onFile: noop }));
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

  it("wires both inputs to the same handler, which resets the value and forwards the file", () => {
    const onFile = vi.fn();
    const inputs = findInputs(PhotoPick({ onFile })).map((el) => el.props as InputProps);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].capture).toBe("environment");
    expect(inputs[1].capture).toBeUndefined();
    expect(inputs[0].onChange).toBeTypeOf("function");
    expect(inputs[1].onChange).toBe(inputs[0].onChange);

    const file = { name: "synthetic.jpg" } as File;
    const target = { files: [file], value: "synthetic.jpg" };
    inputs[1].onChange?.({ target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(onFile).toHaveBeenCalledExactlyOnceWith(file);
    // Reset so picking the same photo again re-fires onChange.
    expect(target.value).toBe("");
  });

  it("ignores an empty pick (chooser cancelled)", () => {
    const onFile = vi.fn();
    const [first] = findInputs(PhotoPick({ onFile })).map((el) => el.props as InputProps);
    const target = { files: [], value: "" };
    first.onChange?.({ target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(onFile).not.toHaveBeenCalled();
  });
});
