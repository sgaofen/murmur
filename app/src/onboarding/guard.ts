// One action at a time — pure, no imports (tests/js/onboarding_flow_check.mjs
// runs this file). A double click on 「开始抓取」 / 「解密并进入」 used to send
// two requests (two admin-password prompts, two decrypts). The dialogs route
// every button through one guard: a call made while another is still running
// is dropped.

export interface ActionGuard {
  /** True while an action started through `run` hasn't settled yet. */
  readonly pending: boolean;
  /** Run `fn` unless another action is still in flight; resolves when it settles. */
  run(fn: () => unknown): Promise<void>;
}

export function createActionGuard(): ActionGuard {
  let pending = false;
  return {
    get pending() { return pending; },
    run(fn) {
      if (pending) return Promise.resolve();
      pending = true;
      let result: unknown;
      try {
        result = fn();
      } catch (e) {
        pending = false;
        return Promise.reject(e);
      }
      return Promise.resolve(result).then(
        () => { pending = false; },
        (e) => { pending = false; throw e; },
      );
    },
  };
}
