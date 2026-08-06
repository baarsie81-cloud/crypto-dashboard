import test from "node:test";
import assert from "node:assert/strict";
import { exposeDashboardState } from "../js/app-state-bridge.js";

test("dashboard state bridge exposes the same state object read-only", () => {
  const state = { signals: new Map() };
  exposeDashboardState(state);
  assert.equal(globalThis.__cryptoDashboardState, state);
  assert.throws(() => { globalThis.__cryptoDashboardState = {}; }, TypeError);
});
