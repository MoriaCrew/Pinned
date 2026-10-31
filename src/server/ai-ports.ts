import "server-only";
/**
 * Composition root for the decorated capability ports (PIN-61):
 * base adapters (mock under AI_MOCK=1, Meta otherwise) wrapped in
 * timeout -> retry -> reserve -> call -> AiCallLog -> outcome.
 * Product code (PIN-53+) calls these, never the raw adapters.
 */
import type { GameRepository } from "../domain/repository";
import { getCapabilityPorts } from "../gateway";
import type { BudgetStore } from "../gateway/budget";
import {
  collectMetaCallLog,
  decoratePorts,
  type DecoratedPorts,
} from "../gateway/decorators";
import { getPolicy } from "../policy/server";
import type { Policy, PolicyOverrides } from "../policy/policy";
import { getBudgetStore } from "./budget-store";
import { getGameRepository } from "./repository";

export interface AiPortsDeps {
  repository?: GameRepository;
  budget?: BudgetStore;
  policy?: Policy;
}

export function getAiPorts(
  deps: AiPortsDeps = {},
  boardOverrides?: PolicyOverrides | null,
): DecoratedPorts {
  const repository = deps.repository ?? getGameRepository();
  return decoratePorts(
    getCapabilityPorts({ onLog: collectMetaCallLog }),
    {
      policy: deps.policy ?? getPolicy(boardOverrides),
      budget: deps.budget ?? getBudgetStore(),
      appendLog: (log) => repository.appendAiCallLog(log),
    },
  );
}
