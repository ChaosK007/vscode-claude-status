/**
 * formatDuration — pure, DOM-free duration formatter.
 *
 * Converts a duration in whole seconds to a human-readable string using
 * caller-supplied i18n templates (e.g. "__N__h __N2__m").
 *
 * The inline `fmt()` function embedded in the WebView HTML template
 * (panel.ts, search "// sync: formatDuration.ts") implements identical
 * logic in plain JS.  Keep both in sync when changing behaviour here.
 *
 * Rollover rule
 * ─────────────
 * After rounding, sub-units can reach their maximum (m=60, h=24).
 * We normalise upward so the output never contains "60m" or "24h":
 *
 *   seconds < 3600  → minutes branch
 *     m = round(seconds/60)
 *     if m === 60 → promote to hours branch with h=1
 *
 *   seconds < 86400 → hours branch
 *     h = floor(seconds/3600)
 *     m = round((seconds % 3600)/60)
 *     if m === 60 → m=0, h+=1
 *     if h === 24 → promote to days branch with d=1, h=0
 *
 *   else            → days branch
 *     d = floor(seconds/86400)
 *     h = round((seconds % 86400)/3600)
 *     if h === 24  → h=0, d+=1
 */

export interface DurationI18n {
  unitM:  string;   // e.g. "__N__m"
  unitH:  string;   // e.g. "__N__h"
  unitHM: string;   // e.g. "__N__h __N2__m"
  unitD:  string;   // e.g. "__N__d"
  unitDH: string;   // e.g. "__N__d __N2__h"
}

function r2(tmpl: string, a: number, b: number): string {
  return tmpl.replace('__N__', String(a)).replace('__N2__', String(b));
}

export function formatDuration(seconds: number, i18n: DurationI18n): string {
  if (seconds < 3600) {
    let m = Math.round(seconds / 60);
    if (m === 60) {
      // Rollover: 59m 30s rounds up to 60m → promote to 1h
      return i18n.unitH.replace('__N__', '1');
    }
    return i18n.unitM.replace('__N__', String(m));
  }

  if (seconds < 86400) {
    let h = Math.floor(seconds / 3600);
    let m = Math.round((seconds % 3600) / 60);
    if (m === 60) { m = 0; h += 1; }
    if (h === 24) {
      // Rolled up to a full day
      return i18n.unitD.replace('__N__', '1');
    }
    return m === 0
      ? i18n.unitH.replace('__N__', String(h))
      : r2(i18n.unitHM, h, m);
  }

  let d = Math.floor(seconds / 86400);
  let h = Math.round((seconds % 86400) / 3600);
  if (h === 24) { h = 0; d += 1; }
  return h === 0
    ? i18n.unitD.replace('__N__', String(d))
    : r2(i18n.unitDH, d, h);
}
