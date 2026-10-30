"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { SKINS, type SkinId } from "../../../domain/skins";
import {
  BoardHeader,
  Button,
  Chip,
  Developing,
  Dock,
  EmptyState,
  Hint,
  Pin,
  PlusSheet,
  SceneCard,
  SectionHead,
  SkinPicker,
  Sticker,
  Tag,
  TextField,
  TryOnBar,
  skinMood,
  skinName,
  type PlusPlan,
} from "../../../ui";

const LAB = "/lab";
const people = [
  { id: "robin-7", name: "Robin" },
  { id: "sam-7", name: "Sam" },
  { id: "jo", name: "Jo" },
  { id: "aye-2", name: "Aye" },
  { id: "lou", name: "Lou" },
];
const things = [
  { id: "teal-mug", label: "Teal mug", owner: people[0] },
  { id: "rubber-duck", label: "Rubber duck", owner: people[1] },
  { id: "potted-succulent", label: "Succulent", owner: people[0] },
  { id: "red-alarm-clock", label: "Alarm clock", owner: people[1] },
  { id: "orange-tabby-cat", label: "Biscuit the cat", owner: people[2] },
  { id: "red-sneakers", label: "Red sneakers", owner: people[3] },
  { id: "straw-hat", label: "Straw hat", owner: people[3] },
  { id: "stacked-books", label: "Book stack", owner: people[1] },
  { id: "black-cat", label: "Pepper the cat", owner: people[4] },
].map((thing) => ({ ...thing, src: `${LAB}/cutout-${thing.id}.webp` }));
const byId = Object.fromEntries(things.map((thing) => [thing.id, thing]));
const credit = (id: string) => ({ thing: byId[id].label.toLowerCase(), owner: byId[id].owner, src: byId[id].src });
const noop = () => {};

function Phone({ skin, children }: { skin: SkinId; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p style={{ margin: 0, font: "700 15px/20px var(--font-ui)" }}>
        {skinName(skin)} <span style={{ fontWeight: 500, color: "var(--ink-muted)" }}>{skinMood(skin)}</span>
      </p>
      <div
        className="pn-skin-root"
        data-theme={skin}
        style={{ position: "relative", width: 390, height: 844, overflow: "hidden", borderRadius: 36, boxShadow: "0 0 0 1px rgba(0,0,0,.12), 0 20px 40px -20px rgba(0,0,0,.45)" }}
      >
        {children}
      </div>
    </div>
  );
}

function BoardDemo({ skin, picking }: { skin: SkinId; picking?: boolean }) {
  const ids = ["teal-mug", "rubber-duck", "red-sneakers", "red-alarm-clock", "orange-tabby-cat", "straw-hat", "stacked-books", "potted-succulent", "black-cat"];
  const picked = picking ? ["rubber-duck", "straw-hat"] : [];
  return (
    <Phone skin={skin}>
      <BoardHeader title="Mia's 7th birthday" people={people} counts={{ people: 5, things: 14, scenes: 3 }} onShare={noop} />
      {picking ? (
        <div style={{ padding: "4px 16px 12px" }}>
          <Hint onDismiss={noop} x={40}>Tap up to 4 things — from anyone</Hint>
        </div>
      ) : (
        <>
          <SectionHead title="Scenes" count={3} />
          <div style={{ padding: "0 16px" }}>
            <ul className="pn-prints">
              <li>
                <SceneCard src={`${LAB}/scene-picnic-mug-duck.webp`} idea="A tiny picnic on the lawn" kind="remix" ratio="4 / 3" number={3} seed="s1" />
              </li>
              <li>
                <SceneCard src={`${LAB}/scene-desk-clock-books.webp`} idea="Sunday morning" ratio="4 / 3" number={2} seed="s2" />
              </li>
            </ul>
          </div>
          <SectionHead title="Things" count={14} />
        </>
      )}
      <ul className="pn-pins" style={{ padding: "0 12px" }}>
        {ids.map((id) => {
          const thing = byId[id];
          const index = picked.indexOf(id);
          return (
            <Pin
              key={id}
              as="li"
              src={thing.src}
              label={thing.label}
              owner={thing.owner}
              seed={id}
              state={index >= 0 ? "picked" : "rest"}
              pickIndex={index + 1}
              onToggle={picking ? noop : undefined}
            />
          );
        })}
      </ul>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 16 }}>
        {picking ? (
          <Dock mode="picking" picked={picked.map((id) => byId[id])} max={4} onCancel={noop} onNext={noop} />
        ) : (
          <Dock onAdd={noop} onMake={noop} />
        )}
      </div>
    </Phone>
  );
}

export function UiLab() {
  const [skin, setSkin] = useState<SkinId>("zine");
  const [plan, setPlan] = useState<PlusPlan>("board");
  const row: CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" };
  return (
    <main className="pn-skin-root" data-theme="paper" style={{ minHeight: "100dvh", padding: 24, display: "grid", gap: 40 }}>
      <header>
        <h1 className="pn-board-title">UI lab</h1>
        <p className="pn-board-meta">Pinneds design system v1 · every component in every skin</p>
      </header>

      <section style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
        {SKINS.map((s) => (
          <BoardDemo key={s.id} skin={s.id} />
        ))}
      </section>

      <section style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
        <BoardDemo skin="paper" picking />
        <Phone skin="fridge">
          <BoardHeader title="Sunday pancakes" people={people.slice(0, 1)} counts={{ people: 1, things: 0, scenes: 0 }} onShare={noop} />
          <EmptyState onAction={noop} onShare={noop} />
        </Phone>
        <Phone skin="darkroom">
          <div style={{ padding: 16, display: "grid", gap: 20 }}>
            <TryOnBar skin="darkroom" onUndo={noop} onKeep={noop} />
            <Developing stickers={[byId["black-cat"], byId["stacked-books"]]} idea="A reading nook at midnight" elapsed="0:12" ratio="4 / 3" />
            <SceneCard
              src={`${LAB}/scene-desk-clock-books.webp`}
              idea="Sunday morning, nowhere to be"
              credits={[credit("red-alarm-clock"), credit("stacked-books")]}
              remixOf={{ title: "Sunday on the balcony", owner: "Jo" }}
              kind="remix"
              ratio="4 / 3"
              number={5}
              onRemix={noop}
              onShare={noop}
              onMore={noop}
            />
          </div>
        </Phone>
        <Phone skin="marigold">
          <PlusSheet plan={plan} onPlanChange={setPlan} prices={{ board: "$3.99", host: "$4.99" }} available={false} foilSrc={byId["rubber-duck"].src} layer="absolute" onClose={noop} />
        </Phone>
      </section>

      <section style={{ display: "grid", gap: 16, maxWidth: 820 }}>
        <SkinPicker
          skins={SKINS.map((s) => ({ id: s.id, suggested: s.id === "zine", locked: s.plus }))}
          value={skin}
          onChange={setSkin}
          sample={[byId["red-sneakers"].src, byId["rubber-duck"].src, byId["straw-hat"].src]}
        />
      </section>

      {SKINS.map((s) => (
        <section key={s.id} className="pn-skin-root" data-theme={s.id} style={{ padding: 20, borderRadius: 20, display: "grid", gap: 16 }}>
          <h2 className="pn-section-title">{skinName(s.id)}</h2>
          <div style={row}>
            <Button variant="primary" size="lg" icon="camera">Add photo</Button>
            <Button icon="scene">Make a scene</Button>
            <Button size="sm" icon="remix">Remix</Button>
            <Button variant="quiet">Not now</Button>
            <Tag>Made from</Tag>
            <Tag tone="ink">Collage</Tag>
            <Tag tone="mark" icon="remix">Remix</Tag>
            <Tag tone="outline" icon="lock">Plus</Tag>
          </div>
          <div style={{ ...row, alignItems: "flex-start", gap: 20 }}>
            <Sticker src={byId["teal-mug"].src} seed={`${s.id}-a`} />
            <Sticker src={byId["rubber-duck"].src} seed={`${s.id}-b`} state="picked" pickIndex={1} />
            <Sticker src={byId["red-alarm-clock"].src} seed={`${s.id}-c`} state="dropped" />
            <Sticker src={byId["orange-tabby-cat"].src} seed={`${s.id}-d`} state="cutting" />
            <Sticker src={byId["red-sneakers"].src} seed={`${s.id}-e`} foil />
          </div>
          <div style={row}>
            <Chip thumb={byId["straw-hat"].src} selected>A tiny picnic</Chip>
            <Chip thumb={byId["red-sneakers"].src}>At the beach</Chip>
            <Chip icon="plus">Write your own</Chip>
          </div>
          <div style={{ ...row, alignItems: "flex-start", gap: 20 }}>
            <div style={{ width: 300 }}>
              <SceneCard src={`${LAB}/scene-picnic-mug-duck.webp`} idea="A tiny picnic on the lawn" kind="remix" ratio="4 / 3" number={3} seed={`${s.id}-remix`} />
            </div>
            <div style={{ width: 300 }}>
              <SceneCard src={`${LAB}/scene-desk-clock-books.webp`} idea="Sunday morning" kind="collage" ratio="4 / 3" number={2} seed={`${s.id}-collage`} />
            </div>
          </div>
          <div style={{ ...row, alignItems: "flex-start" }}>
            <div style={{ width: 300 }}>
              <TextField label="Board name" defaultValue="Mia's 7th birthday" maxLength={40} help="Everyone with the link sees it" />
            </div>
            <div style={{ width: 300 }}>
              <TextField label="Your name" placeholder="So people know it's yours" error="Add a name first" />
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}
