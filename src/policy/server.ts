import "server-only";
/** Server Policy accessor (PIN-59). Env reads go through src/config.ts. */
import { getConfig } from "../config";
import {
  parsePolicyOverridesJson,
  resolvePolicy,
  type Policy,
  type PolicyOverrides,
} from "./policy";

let cachedEnvPolicy: Policy | null = null;

function envLayer(): PolicyOverrides {
  const cfg = getConfig();
  const jsonLayer = parsePolicyOverridesJson(cfg.policyOverridesJson);
  return {
    ...(jsonLayer ?? {}),
    // Config (host env) wins for budget + models unless the JSON
    // layer explicitly overrides that exact field.
    dailyBudgetUsd: jsonLayer?.dailyBudgetUsd ?? cfg.aiDailyBudgetUsd,
    dailyCallLimit: jsonLayer?.dailyCallLimit ?? cfg.aiDailyCallLimit,
    models: {
      spark: jsonLayer?.models?.spark ?? cfg.meta.sparkModel,
      sam: jsonLayer?.models?.sam ?? cfg.meta.samModel,
      image: jsonLayer?.models?.image ?? cfg.meta.imageModel,
      voice: jsonLayer?.models?.voice ?? cfg.meta.voiceModel,
    },
  };
}

/**
 * Effective Policy, optionally with a board's stored overrides.
 * Board fetch lands with the board repository (PIN-62/63); until
 * then callers pass overrides explicitly.
 */
export function getPolicy(boardOverrides?: PolicyOverrides | null): Policy {
  if (!boardOverrides) {
    cachedEnvPolicy ??= resolvePolicy(envLayer());
    return cachedEnvPolicy;
  }
  return resolvePolicy(envLayer(), boardOverrides);
}
