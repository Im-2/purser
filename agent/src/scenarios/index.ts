import { scenarioA } from "./a.js";
import { scenarioB } from "./b.js";
import { scenarioC } from "./c.js";
import { scenarioD } from "./d.js";
import type { ScenarioDef, ScenarioId } from "./types.js";

export * from "./types.js";

export const SCENARIOS: Record<ScenarioId, ScenarioDef> = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD };
/** Order used by "all": the happy path first, as in the video outline. */
export const ALL_ORDER: ScenarioId[] = ["D", "A", "B", "C"];

export function parseScenarioId(s: string): ScenarioId | null {
  const u = s.trim().toUpperCase();
  return u === "A" || u === "B" || u === "C" || u === "D" ? u : null;
}
