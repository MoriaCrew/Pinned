# Landing showcase sets: how to make, add or change one

The landing page shows one **showcase set** per visit (PIN-175): the
hero sticker pile, then the three "How it works" pictures. This page
is the working recipe for making a set, adding it to the landing and
changing it later. The try-on and cat sets went through it on
Oct 30 and 31, 2026.

The rule for every set (PIN-170): every photo is synthetic, and every
sticker and scene is made by this app's own pipeline. Spark names the
things, SAM 3.1 cuts them out and Muse Image composes the scene. After
that, files are only resized and cropped, never retouched by hand.

Related:

- Spike decisions and evidence:
  [`eval/showcase/README.md`](../eval/showcase/README.md) (PIN-171).
- How the landing draws a set: `docs/14-design-system.md`, "Showcase
  sets".
- What each shipped file is made from:
  [`public/landing/README.md`](../public/landing/README.md).

## The steps

| # | Step | Output | Where it lives |
| --- | --- | --- | --- |
| 1 | Write the brief | friends, things, scene prompts | the Linear issue and the PR |
| 2 | Make the source photos | one photo per friend | work folder, outside git |
| 3 | Run the app locally with live models | the app on `localhost:3000` | the operator's machine |
| 4 | Drive one board per set | cut-outs, scenes, run record | work folder, outside git |
| 5 | Review and pick | the set's choices | a contact sheet |
| 6 | Build the web files | resized WebPs with the AI marker | `public/landing/sets/<id>/` |
| 7 | Wire the set | a data entry and tag labels | `src/app/landing-sets.data.ts`, `src/i18n/messages/en.json` |
| 8 | Check | tests, phone and desktop screenshots | the PR |
| 9 | Record provenance | per-set table and prompts | `public/landing/README.md` |

Steps 2 to 6 run on scratch scripts today. PIN-172 adds the set
manifest (`eval/showcase/sets.json`) and PIN-173 turns the driver into
`scripts/showcase-build.mjs`. This page is the contract they follow.

## 1. Write the brief

A set tells one small story: friends' things come together in one
scene. Try-on: Maya's mirror selfie, then friends' jacket, beret and
sunglasses, then a selfie wearing them. Cat: a ginger cat, then
friends' beanie, heart sunglasses and skateboard, then the cat skating
down a street.

Plan for:

- 3 to 5 friends with made-up first names (the test rejects anything
  else), each with one photo of 1 to 3 things;
- 6 pile stickers (the test allows 5 to 7), one of them foil;
- a step-1 photo with two things to tag;
- a step-2 trio from at least two friends;
- one scene (make 2 or 3 and pick one).

Write each scene prompt so it names the subject and every item, and
says what to do with each:

> Dress the woman in the mustard corduroy jacket, the red beret and
> the tortoiseshell sunglasses. A waist-up selfie she takes in a sunny
> park in autumn, holding her phone at arm's length, natural phone
> photo.

A vague "try these outfits on" was refused. Every item a prompt names
must be one of the scene's picked pins: otherwise Muse Image draws it
from the text alone, and the scene is no longer made of the pins.

People: a fictional adult, face visible, in outerwear and accessories.
Meta refuses to dress a person in underwear. A flagged face shows the
consent note and never blocks.

Agree an image cap before generating, and count against it. The
try-on and cat sets used 14 generated images, counting the spike's
model bake-off.

## 2. Make the source photos

Model: Muse Image (`muse-image-1.0`, the spike's pick), text to image:
`POST {META_API_BASE_URL}/images/generations` with
`{ model, prompt, size, n: 1 }`. The key is the operator's
`META_API_KEY`, read from an env file kept outside the repo. Never copy
that file into the repo, and never print the key.

Prompt pattern, one photo per friend:

> Casual smartphone photo of [place]: [1 to 3 things with colour and
> material], [placement: a hand's width apart / whole thing in frame
> with space around it], [light]. Real phone photo look: slight grain,
> true-to-life colours, slightly imperfect framing. Not a product shot.
> No text, no logos, no people.

For the person: a full standing mirror selfie or a waist-up selfie,
plain white t-shirt and light jeans, so the borrowed clothes read.

Ask for 1024x1536 (portrait) or 1536x1024 (landscape). Muse Image
returns 1280x1920 or 1920x1280 **WebP**, whatever name you save it
under. Save it as `.webp`: the upload takes the picture's type from the
file extension.

What cuts well, from the runs so far:

- **Contrast.** Put a thing on a plain surface of another colour. A
  cream cable-knit scarf on a cream bench came out ragged.
- **On its own.** Don't rest a thing on large furniture. With a scarf
  on a green armchair, Spark named the armchair and dropped the scarf.
- **Pairs give one sticker.** Tan suede boots came out as one boot.
- **Big enough.** A person photo also yields small extras (tote,
  plant, sneakers). The tote cut-out was 82 px wide, too small for the
  pile.
- **The person fits.** The mask must stay under
  `Policy.usableMaskFrameFraction` of the frame's area; a standing
  person at 38% by 89% of the frame passed.
- **Stop after two failures.** A cream scarf alone on a dark floor
  gave no usable pin twice, so the set dropped it.

## 3. Run the app locally with live models

Run the worktree's app on `localhost:3000` with the operator's env
file loaded at start-up. For example, a small launcher outside the
repo calls `process.loadEnvFile(<path>)`, sets the overrides below and
starts `next dev`.

| Variable | Value | Why |
| --- | --- | --- |
| `AI_MOCK` | `0` | live models |
| `DATA_BACKEND` | `memory` | nothing reaches Firestore or Storage |
| `AUTH_MODE` | `link-only` | no sign-in |
| `PLUS_MODE` | `off` | no paywall |
| `APP_BASE_URL` | `http://localhost:3000` | the app's own address |
| `AI_DAILY_BUDGET_USD` | `10` | a hard stop for the day's spend |
| `AI_DAILY_CALL_LIMIT` | `2000` | room for a full run |

Also unset the Stripe variables, `DEMO_BOARD_SLUG` and
`FIRESTORE_EMULATOR_HOST`. Live calls run only on the operator's
machine. CI stays on `AI_MOCK=1`.

Limits that matter on a local run:

- Credits are off by default (`Policy.credits.enabled`).
- Board creation and uploads are rate-limited in memory, per server
  process. Without a proxy, every local client counts as one IP.
  Restarting the server resets the limits.
- Scenes are capped by `Policy.scenesPerParticipantPerDay` and
  `Policy.scenesPerBoardPerDay`.
- Model timeouts are `Policy.timeoutsMs`. Raise them through
  `POLICY_OVERRIDES_JSON` if a run times out.
- Run one set at a time and retry a failed photo once. The spike's one
  timeout came while two sets were decomposing at once, and the same
  photo worked on retry.

## 4. Drive one board per set

Drive the local app over its public boards API, one board per set.
These are the same calls `scripts/seed-demo-board.mjs` makes:

1. `POST /api/boards` with `{ title, themeId }` creates the board.
   Keep its slug in memory only. A board slug is the board's access
   key, so a driver never logs, saves or prints it.
2. For each friend:
   - `POST /api/boards/{slug}/participants` with `{ displayName }`
     joins; keep the returned cookie for that friend.
   - `POST /api/boards/{slug}/photos` (multipart field `photo`)
     uploads the friend's photo.
   - Poll `GET /api/boards/{slug}/jobs/{jobId}` until the job is
     `ready`, `failed` or `refused`.
3. `POST /api/boards/{slug}/pins/confirm` with `{ jobId, pinIds }`
   keeps the friend's pins.
4. `GET /api/boards/{slug}/elements/{id}/image?kind=cutout` (and
   `kind=flattened`) downloads each cut-out.
5. For each scene:
   - `POST /api/boards/{slug}/scenes` with `{ elementIds, prompt }`
     asks for it.
   - Poll `GET /api/boards/{slug}/scenes/{id}` until it ends.
   - Download `GET /api/boards/{slug}/scenes/{id}/image`.

Pick a scene's elements by a pattern on the label or description, not
by an exact label. Spark names the same thing differently from run to
run ("Smiling Woman", then "Selfie Woman").

The spike's driver read a spec like this one, with photo paths
pointing into the work folder:

```json
{
  "title": "Showcase: cat (synthetic)",
  "friends": [
    { "name": "Aye", "photo": "<work folder>/cat.webp" },
    { "name": "Ben", "photo": "<work folder>/beanie.webp" },
    { "name": "Kim", "photo": "<work folder>/skateboard.webp" }
  ],
  "scenes": [
    {
      "id": "c1-street",
      "prompt": "The orange tabby cat wearing the green beanie and the red heart-shaped sunglasses, riding the skateboard down a sunny street. Low-angle action photo.",
      "pick": [
        { "friend": "Aye", "match": "cat|tabby|kitten" },
        { "friend": "Ben", "match": "beanie|hat" },
        { "friend": "Ben", "match": "heart|sunglass|glasses" },
        { "friend": "Kim", "match": "skate|board" }
      ]
    }
  ]
}
```

It wrote the downloads and a run record next to them: status and time
per photo, labels, face flags, and each scene's status, kind and
prompt version. Keep all of it in the work folder.

## 5. Review and pick

Put every cut-out and scene on one contact sheet (the spike's is
`eval/contact-sheets/PIN-171-showcase-spike.jpg`). Pick:

- the scene;
- the step-1 photo and the two things to tag on it;
- the pile stickers, and which one is foil;
- the three step-2 stickers, from at least two friends.

Drop a cut-out with ragged edges, a missing part or too few pixels to
read at pile size. Check that the scene shows only picked pins.

## 6. Build the web files

Write the picks into the set's folder, `public/landing/sets/<id>/`:

| File | From | Processing |
| --- | --- | --- |
| `cutout-<sticker id>.webp` | the app's SAM cut-out (PNG with alpha) | fit inside 360x640, never enlarged; WebP quality 78, alpha quality 90 |
| `photo-<what>.webp` | the friend's source photo | square crop holding both tagged things, 560 px; WebP quality 72 |
| `scene-<what>.webp` | the picked scene | square crop, 600 px; WebP quality 72 |

360x640 is about twice the largest pile slot on a phone. A set weighs
at most 220 KB in total (try-on: 148 KB, cat: 151 KB).

Metadata: write one XMP packet holding only the IPTC marker for media
made by a trained model. Muse Image writes the same marker into its own
output. Nothing else: no EXIF, no IPTC block, no other XMP. With sharp,
`.webp(...).withXmp(packet)` does this, because sharp drops the input's
metadata by default. The packet:

```xml
<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">
      <Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="r"?>
```

The `classic` set predates the marker and stays as it is: re-encoding
it would change its pixels.

## 7. Wire the set

In `src/app/landing-sets.data.ts`, add one `LandingSet` and list it in
`LANDING_SETS`:

- `id`: url-safe; it is the folder name and the `?set=` value.
- `stickers`: `stickers("<id>", { "<sticker id>": "<owner>" })`. The
  file is `cutout-<sticker id>.webp`.
- `pile`: 5 to 7 slots, `{ sticker, left, top, size, tilt, foil? }`.
- `photo`: `{ src, owner, objectPosition, chips }`, plus `scale` and
  `transformOrigin` to zoom into a wide photo.
- `trio`: 3 slots.
- `scene`: `{ src, objectPosition }`.

Each tag's text is a `landing.sample*` key in
`src/i18n/messages/en.json`, at most 13 characters ("Tortoise glasses"
ran onto the step text). French falls back to English.

Layout rules:

- Every position is a percentage of its box. In the pile, `left` is a
  percentage of the width and `top` of the height. The pile box is
  1 / 0.84 on a phone and 1 / 0.92 on a wide screen.
- `size` is the side of a **square** box, and the picture fits inside
  it. A tall cut-out (a standing person, a skateboard) needs a size
  near 50 to read; a wide one (sunglasses) fills its box.
- Pile slots drop in one after another and draw in order, the last on
  top.
- `tilt` runs from -1 to 1. In the pile, 1 is 9 degrees.
- A tag's `left` and `top` place its **centre** in the step-1 art box,
  which is 124 px wide on a phone.
- The foil sweep recolours whatever it crosses (it turned a mustard
  jacket pink). Put foil on a sticker whose colour the scene does not
  depend on. In a still screenshot it looks like a colour cast.

## 8. Check

```sh
npm run typecheck
npm test
```

`src/app/landing-sets.test.ts` keeps the data and the files in step.
It checks that:

- every referenced file exists and is WebP, and no file in the folder
  is unused;
- the pile has 5 to 7 distinct stickers, and the trio comes from at
  least two friends;
- positions are in range;
- there are two distinct tags whose text is in the catalog and at most
  13 characters long;
- owners are made-up first names;
- the set weighs at most 220 KB;
- there is no EXIF, and no XMP but the marker (none at all on
  `classic`).

`src/app/landing-page.test.ts` renders every set. It checks that only
the set's own files are drawn and that "Show another" points at a
different set.

Then look at `/?set=<id>` at phone size (390x844) and on a wide
screen, and attach the screenshots to the PR. Check that:

- every set gives the same page height, so nothing jumps between sets;
- the phone has no sideways scroll;
- the tags stay inside the photo and off the step text;
- "Show another" opens a different set.

The round "N" badge in dev screenshots is the Next.js dev indicator; it
does not ship.

## 9. Record provenance

Add the set to `public/landing/README.md`:

- its folder line;
- a row per friend: what the photo shows, and the stickers kept;
- each scene's prompt.

Source photos, raw cut-outs, scenes, run records and specs stay in the
work folder, outside git.

## Changing a set later

- **Move things around:** edit the set's slots in the data file, then
  run step 8.
- **Swap a sticker or the scene:**
  - build the new file (step 6);
  - point the data at it;
  - delete the old file (the test fails on unused files);
  - update the provenance table.
- **Retire a set:**
  - delete its folder, its `LANDING_SETS` entry, its `landing.sample*`
    keys and its provenance section;
  - keep at least two sets;
  - check `landing-page.test.ts`, which names `classic` and `cat` in
    one case, and change it if you retired either.
- **Add a set:** steps 1 to 9.

## Keeping it safe in a public repo

- Use synthetic pictures only, never a real person or a real photo,
  and made-up first names only.
- Source photos, raw outputs, run records and specs stay outside git;
  specs hold local paths.
- The model key lives in the operator's env file outside the repo.
  Never copy, print or log it, and never paste it into a PR or Linear.
- Board slugs are access keys: drivers keep them in memory and never
  print them.
- Shipped pictures carry the AI-generated marker and no other
  metadata.

## Cost

The try-on and cat sets took:

- 14 generated source images, counting the spike's model bake-off (4
  of them on Higgsfield);
- under $1 of Meta calls for the photos, cut-outs and scenes.

The dollar figure is a list-price estimate (`docs/16-ai-usage.md`).
The provider dashboard is authoritative.
