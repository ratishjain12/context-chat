import { DurableObject } from "cloudflare:workers";

export interface CircuitState {
  failures: number;
  openUntil: number;
  reason: string;
  probeUntil?: number;
}

const BASE_OPEN_MS = 5 * 60_000;
const MAX_OPEN_MS = 60 * 60_000;
const PROBE_LEASE_MS = 60_000;

// One global instance (getByName("global")) shared by every thread, so an
// account-level failure is learned once, not rediscovered per thread. Keys are
// a provider ("anthropic": no credits / bad key) or a single model
// ("model:@cf/zai-org/glm-5.3": plan-gated). Transient errors never open a
// circuit. Open for 5 min, doubling per consecutive failure up to 1 h; then
// half-open: one caller at a time gets a probe lease, and its success closes it.
export class ProviderHealthDO extends DurableObject<Env> {
  snapshot(): Record<string, CircuitState> {
    return Object.fromEntries(this.ctx.storage.kv.list<CircuitState>());
  }

  recordFailure(key: string, reason: string): CircuitState {
    const failures = (this.ctx.storage.kv.get<CircuitState>(key)?.failures ?? 0) + 1;
    const state = {
      failures,
      reason,
      openUntil: Date.now() + Math.min(BASE_OPEN_MS * 2 ** (failures - 1), MAX_OPEN_MS),
    };
    this.ctx.storage.kv.put(key, state);
    return state;
  }

  recordSuccess(key: string): void {
    this.ctx.storage.kv.delete(key);
  }

  claimProbe(key: string): boolean {
    const state = this.ctx.storage.kv.get<CircuitState>(key);
    const now = Date.now();
    if (!state) {
      return true;
    }
    if (state.openUntil > now || (state.probeUntil ?? 0) > now) {
      return false;
    }
    this.ctx.storage.kv.put(key, { ...state, probeUntil: now + PROBE_LEASE_MS });
    return true;
  }
}
