# Pinned — one link, one game, hosted by an AI

> Group chats already run on random photos, memes, and roasting each other.
> Pinned turns that into a game anyone can start in seconds: create a link,
> drop it in the chat, play. Nothing to install. When the game ends, the
> link becomes a read-only scoreboard. Want another round? Rematch — new
> link, same host, longer memory.

**Meta Global AI Developer Hackathon** · Indie Developer track · Theme:
*Build for Your World* · Solo developer · Oct 26 – Nov 4, 2026

- Hackathon: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details
- Meta event page: https://dev.meta.ai/events/global-hackathon
- Org: https://github.com/MoriaCrew · Tracking: Linear team `PIN` (Pinned)
- Repository: https://github.com/MoriaCrew/Pinned (public, AGPL-3.0 — see License below)

## The game in 30 seconds

1. **Create.** Describe a host in one line — *"a passive-aggressive IT
   helpdesk"*, *"a dramatic sports commentator"*, *"my unimpressed
   grandmother"* — pick a deadline, get a shareable link.
2. **Play async.** The host sets a photo challenge (*"Find the most
   suspicious object on your desk"*). Players submit privately whenever
   they get a minute. The host judges each entry as it arrives and drops
   anonymous teasers to keep the group curious.
3. **Reveal.** Submissions close; every object is revealed with its
   background cut away. Everyone guesses whose is whose.
4. **Poster.** The host announces the winner and turns the game into a
   poster to share back into the chat. The link freezes as a scoreboard.
5. **Rematch.** One tap creates a fresh link. The host quietly inherits a
   short diary — who won, who's lazy, which jokes landed — so round two
   opens with *"Three games. Zero wins. Bold of you to return."*

There is no preset character list. Every host is generated from the
creator's one line, so no two groups get the same game. The game
underneath never changes — the comedy comes from who is running it.

## How Meta's models power it

| Model | Role in Pinned |
| --- | --- |
| **Muse Spark** (Meta Model API) | Generates the host persona from one line; sets the challenge; judges photos against a published rubric; writes teasers, reveal and winner lines; writes the rematch diary. |
| **SAM 3.1** (Meta Model API) | Cuts the submitted object out of each photo for a fair guessing round and a clean poster. Background removal also reduces photo exposure (see privacy notes in requirements). |
| **Muse Image** (Meta Model API) | Generates the poster background/styling; SAM cut-outs are composited on top so every entry stays recognisable. |

Fallback / scale path: Muse Spark Open (open weights) via a hosted
inference partner (Baseten / Fireworks) behind the same gateway
interface; Modal for GPU batch jobs (segmentation/poster) if needed.
Partner status is tracked in Linear (PIN-4), not in this public repo.

## Made to stay friendly

Roasts target the photo, the effort and the timing — never the person.
Each player sets their own roast level (Gentle / Spicy / Feral) and can
keep their entry out of posters and share cards. Original photos are
processed to cut-outs and not kept as originals; EXIF is stripped.

## Status

🚧 **Day 1 — foundation.** Requirements, architecture and work breakdown
are in `docs/`; implementation is tracked as `PIN-*` issues in Linear and
delivered as small PRs (see `docs/03-ai-sdlc.md`). Demo link and video
will be added here before submission (deadline Nov 4, 9:00 PM ET).

## Docs

- `docs/01-requirements.md` — high-level requirements, scope, gaps & decisions
- `docs/02-architecture.md` — conceptual design, data model, AI pipelines
- `docs/03-ai-sdlc.md` — Linear → coding agent → PR → review workflow (solo + Muse)
- `SECURITY.md` — public-repo guardrails: never-commit list + leak runbook
- `AGENTS.md` — instructions for coding agents working this repo

## Quick start (developers)

Implementation stack is being scaffolded under Linear `PIN-2`. Until then:

```bash
git clone https://github.com/MoriaCrew/Pinned.git
cd Pinned
cp .env.example .env   # fill in Meta Model API key; never commit .env
```

## License

AGPL-3.0 — see `LICENSE`. In short: you may use, study and modify this
code, but if you offer a modified version to others over a network you
must release your source under the same licence. Hackathon note: the
organisers separately receive a broad licence to submitted materials
under the event rules; the AGPL governs reuse by everyone else.
