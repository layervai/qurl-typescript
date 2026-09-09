import type { AgentStateStore } from "@layervai/qurl/node";

/** SSM and Secrets Manager have no transaction lock. One process must own each agent state. */
export function lockedStore(store: Omit<AgentStateStore, "withLock">): AgentStateStore {
  let tail = Promise.resolve();
  const result: AgentStateStore = {
    ...store,
    async withLock(operation, signal) {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      let abort: (() => void) | undefined;
      try {
        if (signal) {
          await Promise.race([
            previous,
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        } else await previous;
        entered = true;
        signal?.throwIfAborted();
        let active = true;
        const check = () => {
          if (!active) throw new Error("qURL AWS state lock has expired");
        };
        const scoped: AgentStateStore = {
          load: async (signal) => {
            check();
            const state = await store.load(signal);
            check();
            return state;
          },
          save: async (state, signal) => {
            check();
            return store.save(state, signal);
          },
          withLock: async (operation) => {
            check();
            return operation(scoped);
          },
        };
        try {
          return await operation(scoped);
        } finally {
          active = false;
        }
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
        if (entered) release();
        else void previous.then(release);
      }
    },
  };
  return result;
}

export function errorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
