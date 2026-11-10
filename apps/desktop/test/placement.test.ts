// Place de l'avatar (outil « placer_avatar ») et icône de la barre des tâches : calculs purs, sans Electron.
import { it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { avatarSpot, chatSpot, placeOptions } from "../src/placement.ts";
import { dotPng, COLORS } from "../src/tray-icon.ts";

const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 984 }];
const size = { W: 200, H: 260 };

it("coins de l'écran choisi, avec une marge de 12 px ; la phrase dit où", () => {
  expect(avatarSpot({}, { screens, active: null, ...size })).toEqual({ x: 1708, y: 768, text: { fr: "Avatar placé bas droite sur l'écran 1.", en: "Avatar moved to bottom right on screen 1." } });
  expect(avatarSpot({ corner: "top_left", screen: 2 }, { screens, active: null, ...size })).toMatchObject({ x: 1932, y: 12 });
  expect(avatarSpot({ corner: "center" }, { screens: [screens[0]!], active: null, ...size })).toMatchObject({ x: 860, y: 390, text: { fr: "Avatar placé centre sur l'écran." } });
});

it("fenêtre active : dans son coin ; sans fenêtre active ni écran demandé, une erreur claire", () => {
  const active = { x: 100, y: 100, width: 800, height: 600 };
  expect(avatarSpot({ target: "window", corner: "bottom_left" }, { screens, active, ...size })).toMatchObject({ x: 112, y: 428, text: { fr: "Avatar placé bas gauche sur la fenêtre active." } });
  expect(() => avatarSpot({ target: "window" }, { screens, active: null, ...size })).toThrow();
  let err: unknown;
  try { avatarSpot({ screen: 3 }, { screens, active: null, ...size }); } catch (e) { err = e; }
  expect(err).toEqual({ fr: "il n'y a que 2 écrans", en: "there are only 2 screens" });
});

it("icône : un PNG 32×32 en couleurs vraies avec transparence, opaque au centre", () => {
  const png = dotPng(COLORS.idle);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(32);
  expect(png.readUInt32BE(20)).toBe(32);
  const idat = png.indexOf("IDAT");
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const at = (x: number, y: number) => raw.subarray(y * 129 + 1 + x * 4, y * 129 + 5 + x * 4);
  expect([...at(16, 16)]).toEqual([...COLORS.idle, 255]);
  expect(at(0, 0)[3]).toBe(0);
});

it("charge de la page de l'avatar (IPC avatar:place) : noms anglais, valeurs sûres par défaut", () => {
  expect(placeOptions({ corner: "top_left", screen: 2, target: "window" })).toEqual({ corner: "top_left", screen: 2, target: "window" });
  expect(placeOptions({ corner: "", target: "fenetre" })).toEqual({ corner: "bottom_right", target: "screen" });
  expect(placeOptions(undefined)).toEqual({ corner: "bottom_right", target: "screen" });
  expect(placeOptions({ screen: "3" })).toEqual({ corner: "bottom_right", screen: 3, target: "screen" });
});

// Conversation : au-dessus de la tête de l'avatar (320 × 560, tête de 230 px en bas), sinon dessous, sinon à côté.
const chatSize = { width: 420, height: 520, minHeight: 320 };
const work = { x: 0, y: 0, width: 1920, height: 1040 };
const chat = (avatar: { x: number; y: number; width?: number; height?: number }, area = work) =>
  chatSpot({ avatar: { width: 320, height: 560, ...avatar }, work: area, head: 230, size: chatSize });

it("conversation : juste au-dessus de la tête, bords droits alignés", () => {
  // La tête commence à y = 472 + 330 = 802 : le bas de la conversation est à 794 (8 px au-dessus).
  expect(chat({ x: 1588, y: 472 })).toEqual({ x: 1588 + 320 - 420, y: 794 - 520, width: 420, height: 520 });
});
it("conversation : la hauteur se réduit jusqu'au minimum quand la place manque au-dessus", () => {
  // Haut de la tête à y = 100 + 330 = 430 → bas à 422 : 422 px disponibles.
  expect(chat({ x: 1000, y: 100 })).toEqual({ x: 900, y: 0, width: 420, height: 422 });
  // 330 px disponibles : encore au-dessus, réduite à 330.
  expect(chat({ x: 1000, y: 8 })).toMatchObject({ y: 0, height: 330 });
});
it("conversation : trop juste au-dessus (moins de 320 px), elle passe sous l'avatar", () => {
  // Au-dessus il reste 322 - 20 = 302 px : sous l'avatar (bas à 560, plus 8 px).
  expect(chat({ x: 500, y: 0 }, { x: 0, y: 20, width: 1920, height: 1400 })).toEqual({ x: 400, y: 568, width: 420, height: 520 });
  // Sous l'avatar, la hauteur se réduit aussi.
  expect(chat({ x: 500, y: 0 }, { x: 0, y: 20, width: 1920, height: 980 })).toMatchObject({ y: 568, height: 432 });
});
it("conversation : ni au-dessus ni dessous, à côté de l'avatar (à gauche, sinon à droite)", () => {
  const small = { x: 0, y: 40, width: 1920, height: 660 };   // 282 px au-dessus, 132 px dessous
  expect(chat({ x: 1000, y: 0 }, small)).toEqual({ x: 1000 - 8 - 420, y: 40, width: 420, height: 520 });
  // Pas de place à gauche : à droite.
  expect(chat({ x: 100, y: 0 }, small)).toMatchObject({ x: 100 + 320 + 8, width: 420 });
});
it("conversation : jamais hors de la zone utile (bord gauche, écran secondaire, écran plus petit que la fenêtre)", () => {
  // Avatar collé à gauche : les bords droits alignés mettraient la fenêtre hors de l'écran.
  expect(chat({ x: 0, y: 472 })).toMatchObject({ x: 0 });
  // Deuxième écran à droite.
  const second = { x: 1920, y: 0, width: 1280, height: 984 };
  const spot = chat({ x: 1920 + 1280 - 332, y: 984 - 568 }, second);
  expect(spot.x).toBeGreaterThanOrEqual(second.x);
  expect(spot.x + spot.width).toBeLessThanOrEqual(second.x + second.width);
  expect(spot.y).toBeGreaterThanOrEqual(0);
  expect(spot.y + spot.height).toBeLessThanOrEqual(984);
  // Zone plus petite que la taille voulue : la fenêtre tient dans la zone.
  const tiny = { x: 10, y: 20, width: 380, height: 300 };
  expect(chat({ x: 50, y: 30 }, tiny)).toEqual({ x: 10, y: 20, width: 380, height: 300 });
});
