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

Remix variant (PIN-79, docs/11 section 5.7): when the port input
carries `parentSceneImageRef`, the same builder places the parent
scene FIRST — one `input_text` base-scene label ("Base scene:
keep this exact scene recognisable and compose the new elements
into it:") and the parent `input_image` — then the NEW elements
(labelled as above), then this same final instruction LAST. The
remix is stateless: `store=false` and no `previous_response_id`.
The final instruction above the rule is unchanged by the variant,
so the remix stays `scene.v1`; the only new fixed text is the
base-scene label, the remix twin of the "Element N" binding text.
