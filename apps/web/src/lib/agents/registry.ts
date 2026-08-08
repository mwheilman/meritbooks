/**
 * SUPERVISED AGENT ORCHESTRATION (M9) — recipe registry.
 *
 * The single place that enumerates the concrete agent loops the runner can drive.
 * Keeping it here means the API (start/list) and the loader (advance) agree on which
 * recipe keys exist, and adding a new loop is one import + one array entry.
 */

import type { AgentRecipe } from './types';
import { apIntakeRecipe } from './recipes/ap-intake';
import { orderToCashRecipe } from './recipes/order-to-cash';
import { closeRunRecipe } from './recipes/close-run';
import { payRunRecipe } from './recipes/pay-run';
import { procureToPayRecipe } from './recipes/procure-to-pay';
import { collectionsAutopilotRecipe } from './recipes/collections-autopilot';

export const RECIPES: readonly AgentRecipe[] = [
  apIntakeRecipe,
  orderToCashRecipe,
  closeRunRecipe,
  payRunRecipe,
  procureToPayRecipe,
  collectionsAutopilotRecipe,
];

const RECIPE_MAP: Readonly<Record<string, AgentRecipe>> = Object.fromEntries(
  RECIPES.map((r) => [r.key, r]),
);

/** Resolve a recipe by key, or undefined when unknown. */
export function getRecipe(key: string): AgentRecipe | undefined {
  return RECIPE_MAP[key];
}

/** Lightweight catalog for the UI (no step functions). */
export interface RecipeSummary {
  key: string;
  label: string;
  description: string;
  feature: string | null;
  steps: Array<{ name: string; label: string; kind: AgentRecipe['steps'][number]['kind'] }>;
}

export function listRecipeSummaries(): RecipeSummary[] {
  return RECIPES.map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    feature: r.feature ?? null,
    steps: r.steps.map((s) => ({ name: s.name, label: s.label, kind: s.kind })),
  }));
}
