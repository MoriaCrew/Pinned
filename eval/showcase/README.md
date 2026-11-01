# Landing showcase sets: spike decisions (PIN-171)

The landing page shows one of several showcase sets (PIN-170). Every
photo in a set is synthetic, and every sticker and scene is made by
this app's own pipeline: Spark names the things, SAM 3.1 cuts them out,
Muse Image composes the scene. This note records what the PIN-171
spike decided, with the evidence, so the set run (PIN-172, PIN-173)
can follow it.

Contact sheet: [`eval/contact-sheets/PIN-171-showcase-spike.jpg`](../contact-sheets/PIN-171-showcase-spike.jpg).
Every image on it is AI-generated. The woman is a fictional person.

## Decisions (Oct 30, 2026)

1. **Source photos come from Muse Image (`muse-image-1.0`) for every
   set.** We compared two prompts on three models: Muse Image,
   Higgsfield Soul 2.0 and Nano Banana Pro. The prompts were a full
   standing mirror selfie and a dresser with a beret and sunglasses.
   - All three made believable selfies.
   - Soul 2.0 turned the dresser prompt into a flat, top-down
     product shot.
   - Nano Banana Pro was strong, but its person was small in the
     frame.
   - Muse Image matched the "casual phone snapshot" brief on both
     prompts.

   It also keeps the whole chain on Meta models (photo, names,
   cut-outs, scene). It is the same model that draws the scenes, so
   photos and scenes look alike. And it writes the AI-generated
   marker into its own output (see Metadata).
2. **The try-on set is a go.**
   - 6 of 6 try-on scenes came back ready as AI scenes, with none
     refused. Each used a woman's selfie plus a friend's jacket and
     another friend's beret and sunglasses.
   - She stays recognisably the same person across scenes.
   - The jacket's corduroy, buttons and pockets carry over.

   Meta refuses to dress a person in underwear, so the set sticks to
   outerwear and accessories.
3. **The local app with live models handles the set run.** The
   recipe is below.

## Results

| Run | Photos to stickers | Scenes |
| --- | --- | --- |
| Try-on, first run | 2 of 3 (the jacket photo failed, see Local live run) | 3 of 3 ready AI, but the jacket was not a pin (see Prompt rules) |
| Jacket photo, retried alone | 1 of 1 | none |
| Try-on with the jacket | 3 of 3 | 3 of 3 ready AI |
| Cat in borrowed gear | 3 of 3 | 2 of 2 ready AI |

| Measure | Value |
| --- | --- |
| Photos to stickers | 9 of 10 on the first try, 10 of 10 with one retry; mean 13.2 s, max 32.5 s |
| Scenes | 8 of 8 ready AI scenes; mean 15.9 s, max 23.0 s |
| Stickers found | 17 across 10 photos; the person was always found and face-flagged |
| Generated source images | 10 of the 40-image cap (6 Muse Image, 4 Higgsfield at 4.2 credits) |
| Meta cost estimate | about $0.50 for 10 photos, 8 scenes and 6 source photos at list-price proxies (`docs/16-ai-usage.md`); the provider dashboard is authoritative |

## Prompt rules learned

- **Name the person and every item, and say what to do with each.**
  For example: "Dress the woman in the mustard corduroy jacket, put the
  red beret on her head and the tortoiseshell sunglasses on her face.
  Keep her face, hair and jeans." A vague "try these outfits on" was
  refused on dev.
- **Every item the prompt names must be a picked pin.** In the first
  try-on run the jacket photo had failed, so the jacket was not a pin.
  Muse Image still drew a mustard jacket from the prompt text alone.
  A showcase scene must be made of its pins, so the build script checks
  that every item named in the prompt is a picked pin.
- **Pick stickers by pattern, not by exact label.** Spark names the
  same photo differently from run to run ("Smiling Woman", then
  "Selfie Woman").
- **A person photo yields extra stickers too** (tote, basket, plant,
  sneakers). That helps the hero pile, but the smallest ones are too
  small to show: the tote cut-out was 82 px wide.

## Source photo recipe

The prompts that worked follow one pattern. Keep it for every set:

> Casual smartphone photo of [place]: [1 to 3 things with colour and
> material], [placement: a hand's width apart / whole thing in frame
> with space around it], [light]. Real phone photo look: slight grain,
> true-to-life colours, slightly imperfect framing. Not a product shot.
> No text, no logos, no people.

For the person: a full standing mirror selfie or a waist-up selfie, a
fictional adult, face visible, plain white t-shirt and light jeans so
the borrowed clothes read. A full-height person was kept, at 38% by
89% of the frame. The limit is the mask's area, under 60% of the frame
(`Policy.usableMaskFrameFraction`), not its height.

Sizes: 1024x1536 for portrait, 1536x1024 for landscape. Muse Image
returns 1280x1920 or 1920x1280 WebP.

## Local live run

Run the app on `localhost:3000` with the operator's external env file
loaded at start-up. Never copy that file into the repo. Override:

- `AI_MOCK=0`
- `DATA_BACKEND=memory`
- `AUTH_MODE=link-only`
- `PLUS_MODE=off`
- `AI_DAILY_BUDGET_USD=10`
- `AI_DAILY_CALL_LIMIT=2000`

Also clear the Stripe variables.

Limits that matter:

- **Credits.** They are off by default (`Policy.credits.enabled`), so
  makes are not capped locally.
- **Board creation.** 10 per hour per server process: without a proxy
  every local client counts as one IP. Restarting the server resets
  this and the other in-memory rate limits.
- **Uploads.** 60 per hour.
- **Scenes.** 10 per participant and 40 per board per day.
- **Run sets one at a time and retry a failed photo once.** The one
  failure took 26.5 s, while two sets were decomposing at once; it was
  most likely a model timeout. The same photo succeeded on retry in
  13.2 s.
- **Timeouts.** Defaults are 30 s for Spark and 20 s for SAM. Raise
  them through `POLICY_OVERRIDES_JSON` (`timeoutsMs`) for the full run.

## Metadata

Muse Image writes an IPTC XMP marker into every image it makes:
`Iptc4xmpExt:DigitalSourceType =
http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`.
Keep that marker on every shipped showcase asset, and strip all other
metadata (PIN-174).

## Where things live

- Original photos, raw cut-outs and scenes stay outside git.
- This note and the contact sheet are the only spike files in the repo.
- The scratch driver becomes `scripts/showcase-build.mjs` in PIN-173.
- The living step-by-step recipe for making, adding or changing a set
  is `docs/17-showcase-sets.md` (PIN-175); this note stays as the
  spike's record.
