/**
 * Color helpers for theming UI around a tracker's user-chosen color.
 *
 * Trackers store a hex color (e.g. "#4ECDC4"). We tint counts/buttons with it,
 * so we need a readable foreground ("ink") that contrasts with that fill.
 */

/** Parse a #rgb / #rrggbb hex string to [r, g, b] (0–255), or null if invalid. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Relative luminance (0–1) per WCAG, used to pick a contrasting ink. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * A readable foreground color (near-black or near-white) for text/icons placed
 * on top of `bg`. Falls back to white for unparseable input.
 */
export function readableInk(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return '#ffffff';
  return luminance(rgb) > 0.55 ? '#0b0f12' : '#ffffff';
}
