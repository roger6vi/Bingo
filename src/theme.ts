// The only theme values that may cross IPC or reach storage; keep aligned with tokens/semantic/.
export const THEME_IDS = ['pixel-classic', 'high-contrast'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'pixel-classic';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}
