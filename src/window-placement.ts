import type { Bounds, PublicWindowPlan } from './window-plan';

export interface MovablePublicWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  once(event: 'leave-full-screen', callback: () => void): unknown;
  setFullScreen(fullscreen: boolean): void;
  setBounds(bounds: Bounds): void;
  focus(): void;
}

/** Apply only the latest requested plan when Electron completes an asynchronous fullscreen exit. */
export function createPublicWindowMover<Window extends MovablePublicWindow>() {
  const pending = new WeakMap<Window, { latest: PublicWindowPlan; leaving: boolean }>();

  return (window: Window, plan: PublicWindowPlan): void => {
    if (window.isDestroyed()) return;
    const state = pending.get(window) ?? { latest: plan, leaving: false };
    state.latest = plan;
    pending.set(window, state);
    if (!state.leaving) {
      if (window.isFullScreen() && !plan.fullscreen) {
        state.leaving = true;
        window.once('leave-full-screen', () => {
          state.leaving = false;
          if (window.isDestroyed()) return;
          window.setBounds(state.latest.bounds);
          if (state.latest.fullscreen) window.setFullScreen(true);
        });
        window.setFullScreen(false);
      } else {
        window.setBounds(plan.bounds);
        if (plan.fullscreen) window.setFullScreen(true);
      }
    }
    window.focus();
  };
}
