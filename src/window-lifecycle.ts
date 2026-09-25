import type { DisplaySnapshot, PublicWindowPlan } from './window-plan';

export interface WindowLifecyclePorts<Window> {
  displays(): readonly DisplaySnapshot[];
  primaryId(): number;
  planPublic(displays: readonly DisplaySnapshot[], primaryId: number): PublicWindowPlan;
  createPublic(plan: PublicWindowPlan): Window;
  movePublic(window: Window, plan: PublicWindowPlan): void;
  notify(pauseSuggested: boolean): void;
}

/** Keeps window identity and placement policy independent of Electron. */
export function createWindowLifecycle<Window>(ports: WindowLifecyclePorts<Window>) {
  let publicWindow: Window | undefined;
  let placement: PublicWindowPlan | undefined;

  return {
    openPublic(): Window {
      if (publicWindow !== undefined) return publicWindow;
      placement = ports.planPublic(ports.displays(), ports.primaryId());
      publicWindow = ports.createPublic(placement);
      ports.notify(false);
      return publicWindow;
    },
    publicClosed(window: Window): void {
      if (publicWindow !== window) return;
      publicWindow = undefined;
      placement = undefined;
      ports.notify(false);
    },
    displaysChanged(): void {
      if (publicWindow === undefined || placement === undefined) return;
      const displays = ports.displays();
      const primaryId = ports.primaryId();
      const selected = displays.find((display) => display.id === placement?.displayId);
      const next = selected
        ? ports.planPublic(displays.filter((display) => display.id === primaryId || display.id === selected.id), primaryId)
        : ports.planPublic(displays.filter((display) => display.id === primaryId), primaryId);
      if (next.displayId === placement.displayId && next.fullscreen === placement.fullscreen &&
          next.bounds.x === placement.bounds.x && next.bounds.y === placement.bounds.y &&
          next.bounds.width === placement.bounds.width && next.bounds.height === placement.bounds.height) return;
      ports.movePublic(publicWindow, next);
      placement = next;
      if (!selected) ports.notify(true);
    },
    moveToSecondary(): boolean {
      if (publicWindow === undefined) return false;
      const plan = ports.planPublic(ports.displays(), ports.primaryId());
      if (!plan.fullscreen) return false;
      ports.movePublic(publicWindow, plan);
      placement = plan;
      ports.notify(false);
      return true;
    },
  };
}
