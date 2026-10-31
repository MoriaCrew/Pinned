# Link card fonts (PIN-102)

TrueType copies of the design system faces for the board link card
(`src/app/g/[slug]/opengraph-image.tsx`). The image renderer behind
`next/og` reads TTF/OTF only, not the woff2 files in `public/fonts`.

Every family is licensed under the SIL Open Font License 1.1
(https://openfontlicense.org), which allows bundling and serving them
with this app. Source: the static instances Google Fonts serves for
the weight below, subset with `pyftsubset` to Basic Latin, Latin-1,
Latin Extended-A and common punctuation (kerning and ligatures kept).

| File | Family | Weight | Role on the card | Copyright |
| --- | --- | --- | --- | --- |
| `AtkinsonHyperlegibleNext-600.ttf` | Atkinson Hyperlegible Next | 600 | Invite line | Braille Institute of America |
| `AtkinsonHyperlegibleMono-500.ttf` | Atkinson Hyperlegible Mono | 500 | Counts line | Braille Institute of America |
| `BricolageGrotesque-800.ttf` | Bricolage Grotesque | 800 | Wordmark, Paper titles | The Bricolage Grotesque Project Authors |
| `Fraunces-600.ttf` | Fraunces | 600 | Cork titles | The Fraunces Project Authors |
| `Fredoka-600.ttf` | Fredoka | 600 | Fridge titles | The Fredoka Project Authors |
| `Anton-400.ttf` | Anton | 400 | Zine titles | The Anton Project Authors |
| `InstrumentSerif-400-italic.ttf` | Instrument Serif | 400 italic | Darkroom titles | The Instrument Serif Project Authors |
| `YoungSerif-400.ttf` | Young Serif | 400 | Postcard titles | The Young Serif Project Authors |
| `AbrilFatface-400.ttf` | Abril Fatface | 400 | Marigold titles | TypeTogether |

To refresh a file: request `https://fonts.googleapis.com/css2?family=<Family>:wght@<w>`
with a user agent that does not support woff2 (the response then lists
`.ttf` URLs), download it, and subset with
`pyftsubset <in>.ttf --unicodes="U+0020-007E,U+00A0-00FF,U+0100-017F,U+0218-021B,U+02BC,U+02C6,U+02DA,U+02DC,U+2010-2027,U+2030-203A,U+2044,U+20AC,U+2122,U+2190-2193,U+2212" --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk' --output-file=<out>.ttf`.
