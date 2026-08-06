export function exposeDashboardState(state) {
  Object.defineProperty(globalThis, "__cryptoDashboardState", {
    value: state,
    configurable: true,
    writable: false,
    enumerable: false,
  });
}

export function notifyDashboardRender() {
  globalThis.dispatchEvent?.(new Event("crypto-dashboard-render"));
}
