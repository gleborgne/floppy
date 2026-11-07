// Place de l'avatar (outil « placer_avatar ») et icône de la barre des tâches : calculs purs, sans Electron.
import { it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { avatarSpot } from "../src/placement.mjs";
import { dotPng, COLORS } from "../src/tray-icon.mjs";

const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 984 }];
const size = { W: 200, H: 260 };

it("coins de l'écran choisi, avec une marge de 12 px ; la phrase dit où", () => {
  expect(avatarSpot({}, { screens, active: null, ...size })).toEqual({ x: 1708, y: 768, text: { fr: "Avatar placé bas droite sur l'écran 1.", en: "Avatar moved to bottom right on screen 1." } });
  expect(avatarSpot({ coin: "haut_gauche", ecran: 2 }, { screens, active: null, ...size })).toMatchObject({ x: 1932, y: 12 });
  expect(avatarSpot({ coin: "centre" }, { screens: [screens[0]!], active: null, ...size })).toMatchObject({ x: 860, y: 390, text: { fr: "Avatar placé centre sur l'écran." } });
});

it("fenêtre active : dans son coin ; sans fenêtre active ni écran demandé, une erreur claire", () => {
  const active = { x: 100, y: 100, width: 800, height: 600 };
  expect(avatarSpot({ cible: "fenetre", coin: "bas_gauche" }, { screens, active, ...size })).toMatchObject({ x: 112, y: 428, text: { fr: "Avatar placé bas gauche sur la fenêtre active." } });
  expect(() => avatarSpot({ cible: "fenetre" }, { screens, active: null, ...size })).toThrow();
  let err: unknown;
  try { avatarSpot({ ecran: 3 }, { screens, active: null, ...size }); } catch (e) { err = e; }
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
