/** Fast vindu per nøkkel (typisk IP). Nok til å stoppe misbruk av en demo. */
export function lagRatebegrenser(maks: number, vinduMs: number, now = () => Date.now()) {
  const teller = new Map<string, { start: number; antall: number }>();
  return {
    /** Sann hvis forespørselen er innenfor grensen. */
    tillat(nokkel: string): boolean {
      const t = now();
      const v = teller.get(nokkel);
      if (!v || t - v.start >= vinduMs) {
        teller.set(nokkel, { start: t, antall: 1 });
        if (teller.size > 10_000) for (const [k, x] of teller) if (t - x.start >= vinduMs) teller.delete(k);
        return true;
      }
      v.antall++;
      return v.antall <= maks;
    },
  };
}
