/**
 * Klinikken lever i Europe/Oslo. Vi regner med «naive» lokale tider
 * (YYYY-MM-DDTHH:MM) og lagrer dem som Date i UTC-feltene, så vi slipper
 * sommertid-matematikk i domenelogikken.
 */
export function osloNaa(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")));
}

export function isoDato(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isoTid(d: Date): string {
  return d.toISOString().slice(0, 16);
}

const UKEDAGER = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const MANEDER = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];

/** «torsdag 22. oktober kl. 08:30», slik det skal sies i telefonen. */
export function lesbarTid(iso: string): string {
  const d = new Date(`${iso}:00Z`);
  const kl = iso.slice(11, 16);
  return `${UKEDAGER[d.getUTCDay()]} ${d.getUTCDate()}. ${MANEDER[d.getUTCMonth()]} kl. ${kl}`;
}

export function lesbarDato(d: Date): string {
  return `${UKEDAGER[d.getUTCDay()]} ${d.getUTCDate()}. ${MANEDER[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
