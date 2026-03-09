/**
 * Hook emitter — dispatches lifecycle events to registered hooks.
 */

import type {
  HookEvent,
  HookDefinition,
  HookEventMap,
} from "./types.js";

export class HookEmitter {
  private hooks: HookDefinition[] = [];

  register(hook: HookDefinition): void {
    this.hooks.push(hook);
  }

  registerAll(hooks: HookDefinition[]): void {
    for (const hook of hooks) {
      this.register(hook);
    }
  }

  /**
   * Emit an event and collect results from matching hooks.
   * Hooks are called in registration order.
   * For "before_" events, the first non-void result wins.
   * For observation events (agent_end, turn_end), all hooks run.
   */
  async emit<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]["payload"],
    filterContext?: { tool?: string; agentType?: string },
  ): Promise<HookEventMap[E]["result"] | void> {
    const matching = this.hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (hook.filter?.tool && filterContext?.tool && hook.filter.tool !== filterContext.tool) {
        return false;
      }
      if (hook.filter?.agentType && filterContext?.agentType && hook.filter.agentType !== filterContext.agentType) {
        return false;
      }
      return true;
    });

    let lastResult: HookEventMap[E]["result"] | void;

    for (const hook of matching) {
      try {
        const result = await (hook.handler as (p: HookEventMap[E]["payload"]) => Promise<HookEventMap[E]["result"] | void>)(payload);
        if (result !== undefined && result !== null) {
          lastResult = result;
          // For cancellable events, short-circuit on cancel
          if (
            event === "before_tool" &&
            typeof result === "object" &&
            (result as Record<string, unknown>).cancel
          ) {
            return result;
          }
        }
      } catch (error) {
        console.error(`[stella:hook] Error in ${event} hook:`, (error as Error).message);
      }
    }

    return lastResult;
  }

  clear(): void {
    this.hooks = [];
  }
}
