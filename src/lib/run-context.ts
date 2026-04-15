import { AsyncLocalStorage } from "async_hooks";

export type RunCtx = {
  agentId: string;
  label: string;
  currentToolUseId?: string;
};

export const runCtx = new AsyncLocalStorage<RunCtx>();

export function getCtx(): RunCtx | undefined {
  return runCtx.getStore();
}
