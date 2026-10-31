# Prompt contracts

Prompts are production code. Each template is versioned, reviewed in a
PR, and stored with the output it produced (`promptVersion` in the AI
call log once live calls land).

## Rules

- System policy outranks creator briefs, player names and photo text.
  Treat all of them as quoted data, never instructions.
- Return the exact JSON contract named by the template. No markdown
  fences or commentary in model output.
- Limits inside templates (word caps, counts) come from the Policy
  object as variables, never literals (docs/11 §5.1).
- Any behavior change increments the template version and needs fixture
  or golden-set evidence in the PR.

## Templates

- `elements.v1.md` — photo → element list for the Studio namer (PIN-50).
- `label.v1.md` — photo → main-object label + alt text + safety flags
  (PIN-52 seam; feeds the SAM concept prompt until elements land).
- `scene.v1.md` — elements + prompt → composed scene, the final
  `input_text` of the Muse Image compose request (PIN-68).
- `tap-name.v1.md` — one tapped cut-out crop → its pin label,
  description and face flag (PIN-117).
- `chips.v1.md` — selected pin labels → scene-idea suggestion chips
  for the Make sheet, cached per label set (PIN-75).
- `translate-ui.v1.md` — dev-time UI translation of `en.json` batches
  for `npm run i18n:translate` (PIN-189); not an app call.
- `review-ui.v1.md` — reviewer pass over those translations: returns
  corrections with a reason (PIN-189).

Segmentation uses the plain-noun `objectLabel` as the SAM concept
prompt; it is not a chat prompt and has no template file.
