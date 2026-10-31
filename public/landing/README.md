# Landing images

Synthetic images for the landing page's hero sticker pile and the
"How it works" strip (PIN-104). The page shows one **set** per visit
(PIN-175): each set is a folder under `sets/`, described in
`src/app/landing-sets.data.ts` and checked against it by
`src/app/landing-sets.test.ts` (every file exists and is used, no
EXIF, at most 220 KB per set).

No real people and no real photos (see `eval/README.md`): every
picture is AI-generated, and the woman in `try-on` is a fictional
person. The names on the stickers in the data file are made up.

```
sets/
  classic/   the mug and the duck (the landing before PIN-175)
  try-on/    a mirror selfie, friends' jacket, beret and sunglasses
  cat/       a ginger cat, friends' beanie, heart sunglasses and skateboard
```

Every set has the same kinds of file:

| File | Used for |
| --- | --- |
| `cutout-<sticker id>.webp` | a die-cut sticker (hero pile, step 2) |
| `photo-*.webp` | the step-1 photo, shown with two name tags |
| `scene-*.webp` | the step-3 scene print |

## `sets/classic/`

From the project's own eval fixtures (`eval/fixtures/studio`,
generated with Higgsfield text-to-image and cut out by SAM 3.1 in the
PIN-50 spike), resized to WebP. Moved here unchanged from
`public/landing/`. They are copies of the files in `public/lab/`,
except the two cut-outs noted below.

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

## `sets/try-on/` and `sets/cat/`

Made end to end with Meta models and this app (PIN-171 spike, evidence
in `eval/showcase/README.md`; the step-by-step recipe for making,
adding or changing a set is `docs/17-showcase-sets.md`):

1. Muse Image (`muse-image-1.0`) made each friend's photo from a text
   prompt.
2. The app ran locally with live models: Spark named the things,
   SAM 3.1 cut them out, and Muse Image composed the scene from the
   picked pins (`scene.v1`).
3. The files here are those outputs, resized to WebP: cut-outs at most
   360 px wide and 640 px tall, photo and scene cropped square.

The source photos and raw outputs stay outside git.

| Set | Friend | Photo (Muse Image) | Stickers kept |
| --- | --- | --- | --- |
| try-on | Maya | full-length mirror selfie, white t-shirt and jeans | `woman` |
| try-on | Jo | mustard corduroy jacket on a door hook | `mustard-jacket` |
| try-on | Lea | red beret and tortoiseshell sunglasses on a dresser (`photo-dresser-beret-sunglasses.webp`) | `red-beret`, `tortoise-sunglasses` |
| try-on | Nia | red leather bag and a cream scarf on a hallway bench | `red-bag` |
| try-on | Zoe | cream scarf and tan suede boots by a green armchair | `suede-boot` |
| cat | Aye | ginger tabby on a kitchen counter | `ginger-cat` |
| cat | Ben | green beanie and red heart sunglasses on a shelf (`photo-shelf-beanie-glasses.webp`) | `green-beanie`, `heart-sunglasses` |
| cat | Kim | patterned skateboard against a brick wall | `skateboard` |
| cat | Rui | mint headphones and a gold paper crown on a desk | `mint-headphones`, `paper-crown` |

Scenes:

- `scene-park-selfie.webp`: Maya + Jo's jacket + Lea's beret and
  sunglasses, "a waist-up selfie she takes in a sunny park in autumn".
- `scene-street-skate.webp`: Aye's cat + Ben's beanie and heart
  sunglasses + Kim's skateboard, "riding the skateboard down a sunny
  street".

Every file keeps one piece of metadata: the IPTC marker for media made
by a trained model (`Iptc4xmpExt:DigitalSourceType =
http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`),
which Muse Image writes into its own output. The test checks that it
is there and that nothing else is.

## Why copies

`public/lab/` stays the home of the `/lab/ui` samples and is never used
in production UI; `public/start/` has its own three cut-outs for the
look picker. These copies exist so the production landing page does not
depend on either. Identical files in two folders are one blob in git.
