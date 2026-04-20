import type { InputAdapter } from "./types";
import { mvrv } from "./mvrv";
import { puell } from "./puell";
import { sopr } from "./sopr";
import { reserveRisk } from "./reserveRisk";
import { stockToFlow } from "./stockToFlow";
import { ma200w } from "./ma200w";
import { piCycle } from "./piCycle";
import { nvt } from "./nvt";
import { hashRibbons } from "./hashRibbons";
import { difficultyRibbon } from "./difficultyRibbon";
import { minerOutflows } from "./minerOutflows";
import { hodlWaves } from "./hodlWaves";

export const ADAPTERS: InputAdapter[] = [
  mvrv,
  puell,
  sopr,
  reserveRisk,
  stockToFlow,
  ma200w,
  piCycle,
  nvt,
  hashRibbons,
  difficultyRibbon,
  minerOutflows,
  hodlWaves,
];
