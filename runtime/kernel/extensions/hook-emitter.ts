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
   * True if at least one hook is registered for `event`.
   * Filter context is intentionally ignored; false positives are cheap.
   */
  has(event: HookEvent): boolean {
    for (const hook of this.hooks) {
      if (hook.event === event) return true;
    }
    return false;
  }

  /**
   * Emit an event and collect results from matching hooks.
   * Hooks are called in registration order.
   *
   * `agent_end` results are shallow-merged so an extension result cannot
   * accidentally erase bundled fields such as `selfModApplied`. Other events
   * keep last-result-wins semantics, except `before_tool` short-circuits on
   * `cancel: true`. Use {@link emitAll} when every result must be composed.
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

    if (matching.length === 0) {
      return undefined;
    }

    const isMergeableEvent = event === "agent_end";

    let lastResult: HookEventMap[E]["result"] | void = undefined;
    let merged: Record<string, unknown> | undefined;

    for (const hook of matching) {
      try {
        const result = await (hook.handler as (p: HookEventMap[E]["payload"]) => Promise<HookEventMap[E]["result"] | void>)(payload);
        if (result === undefined || result === null) {
          continue;
        }
        if (isMergeableEvent && typeof result === "object") {
          // Filter `undefined` fields out of the result before
          // spreading so a later hook returning `{ key: undefined }`
          // doesn't erase an earlier hook's contribution. Plain
          // object-spread copies undefined values verbatim, which
          // contradicts the documented "later hooks override per-field;
          // undefined is skipped" semantics — the docstring's "omits
          // the key" path was fine, but the explicit-undefined path
          // wasn't. Filtering here aligns runtime behavior with the
          // contract.
          const filtered: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(
            result as Record<string, unknown>,
          )) {
            if (value === undefined) continue;
            filtered[key] = value;
          }
          merged = merged ? { ...merged, ...filtered } : filtered;
          continue;
        }
        lastResult = result;
        if (
          event === "before_tool" &&
          typeof result === "object" &&
          (result as Record<string, unknown>).cancel
        ) {
          return result;
        }
      } catch (error) {
        console.error(`[stella:hook] Error in ${event} hook:`, (error as Error).message);
      }
    }

    if (merged) {
      return merged as HookEventMap[E]["result"];
    }
    return lastResult;
  }

  /**
   * Emit an event and collect ALL non-empty results in registration order.
   *
   * Used when downstream code composes every hook's output itself, such as
   * `before_agent_start` prompt replacement plus appended prompt fragments.
   */
  async emitAll<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]["payload"],
    filterContext?: { tool?: string; agentType?: string },
  ): Promise<Array<HookEventMap[E]["result"]>> {
    const matching = this.hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (
        hook.filter?.tool &&
        filterContext?.tool &&
        hook.filter.tool !== filterContext.tool
      ) {
        return false;
      }
      if (
        hook.filter?.agentType &&
        filterContext?.agentType &&
        hook.filter.agentType !== filterContext.agentType
      ) {
        return false;
      }
      return true;
    });

    const results: Array<HookEventMap[E]["result"]> = [];
    for (const hook of matching) {
      try {
        const result = await (
          hook.handler as (
            p: HookEventMap[E]["payload"],
          ) => Promise<HookEventMap[E]["result"] | void>
        )(payload);
        if (result !== undefined && result !== null) {
          results.push(result as HookEventMap[E]["result"]);
        }
      } catch (error) {
        console.error(
          `[stella:hook] Error in ${event} hook:`,
          (error as Error).message,
        );
      }
    }
    return results;
  }

  clear(): void {
    this.hooks = [];
  }

  /**
   * Selectively clear hooks by their `source` tag. Used by F1 (extension
   * hot-reload) to drop user-extension hooks without touching bundled
   * lifecycle behavior. Hooks without a `source` are treated as
   * "extension" by default so legacy registrations are picked up.
   */
  clearBySource(source: "bundled" | "extension"): void {
    this.hooks = this.hooks.filter((hook) => {
      const hookSource = hook.source ?? "extension";
      return hookSource !== source;
    });
  }
}
