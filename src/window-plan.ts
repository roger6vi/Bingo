export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplaySnapshot {
  readonly id: number;
  readonly bounds: Bounds;
  readonly workArea?: Bounds;
}

export interface PublicWindowPlan {
  readonly displayId: number;
  readonly bounds: DisplaySnapshot['bounds'];
  readonly fullscreen: boolean;
}

export function planOperatorWindow(workArea: Bounds): Bounds {
  return { x: workArea.x, y: workArea.y, width: Math.min(1024, workArea.width), height: Math.min(720, workArea.height) };
}

export function planPublicWindow(displays: readonly DisplaySnapshot[], primaryDisplayId: number): PublicWindowPlan {
  const primary = displays.find((display) => display.id === primaryDisplayId);
  if (!primary) throw new Error('Primary display is missing');

  const secondary = displays.find((display) => display.id !== primaryDisplayId);
  if (secondary) {
    return { displayId: secondary.id, bounds: secondary.bounds, fullscreen: true };
  }

  const area = primary.workArea ?? primary.bounds;
  const width = Math.min(960, area.width);
  const height = Math.min(540, area.height);
  return {
    displayId: primary.id,
    bounds: {
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    },
    fullscreen: false,
  };
}
