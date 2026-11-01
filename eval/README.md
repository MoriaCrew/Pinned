# Evaluation fixtures

The synthetic fixtures under `fixtures/studio/` and the live spike runner
`scripts/studio-spike.mjs` (`npm run spike:studio`) serve as the golden
set; results are in `studio-findings.md`. The 20-photo golden set (PIN-15)
was canceled. This directory is the policy boundary for fixtures.

## Fixture rules

- Use only consented operator photos or clearly synthetic/generated
  images. Higgsfield-generated desk/object scenes are suitable SAM and
  labelling fixtures when they contain no real person or private data.
- Never add real user uploads, family photos, faces, badges,
  documents, screens with private content, or EXIF-bearing originals.
- Record each fixture's source, expected object label, orientation/HEIC
  case where relevant, and consent/synthetic status beside the asset.
- Keep fixtures small and web-sized. Test originals generated during a
  run stay outside git unless promoted under the rules above.

## Planned coverage

Easy isolated objects, cluttered desks, transparent/reflective objects,
multiple candidate objects, dark/blurry images, rotated EXIF images,
HEIC inputs, screens/documents for safety flags, and prompt-injection
text placed inside an image. Measure segmentation fallbacks, label
validity, safety-flag accuracy, latency, and cost per photo and scene.
