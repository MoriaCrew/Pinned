# Landing images

Synthetic images for the landing page's hero sticker pile and the
"How it works" strip (PIN-104). They are copies of the files in
`public/lab/`, which come from the project's own eval fixtures
(`eval/fixtures/studio`, generated with Higgsfield text-to-image and
cut out by SAM 3.1 in the PIN-50 spike), resized to WebP. No real
people and no real photos (see `eval/README.md`).

| File | Source fixture |
| --- | --- |
| `cutout-*.webp` | `eval/fixtures/studio/elements/*-flat.jpg`, white background removed |
| `photo-desk-mug-duck.webp` | `photos/desk-mug-duck.jpg` |
| `scene-picnic-mug-duck.webp` | `scenes/C1-size-1024x1536.jpg` |

Two cut-outs differ from their `public/lab/` originals: in
`cutout-teal-mug.webp` (handle) and `cutout-red-alarm-clock.webp`
(gap under the bell handle) the opaque white that the white-background
removal left inside a hole was made transparent, so the die-cut
keyline follows the hole like a real sticker.

`public/lab/` stays the home of the `/lab/ui` samples. These copies
exist so the production landing page does not depend on lab files.
