Compose these exact elements into one new photorealistic scene, keeping each element recognisable: {{PROMPT}}

---
Prompt: scene.v1 (PIN-68, from the PIN-50 spike). The line above the
rule is the verbatim final `input_text` of the compose request; the
builder (`buildSceneResponsesBody` in `src/gateway/ports.ts`)
substitutes the user's prompt into the {{PROMPT}} slot and places it
LAST, after one `input_text` label ("Element N (from X): label") and
one flattened `input_image` per element (docs/11 section 5.6). The
request carries only `tools: [{type: "image_generation", size}]`
(size from Policy) and `store` from Policy; the image is read from
`image_generation_call.result`, and HTTP 200 with no such item is
the typed `refused` outcome.
