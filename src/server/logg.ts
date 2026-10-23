/**
 * Lagrer hver samtale som én JSON-fil. Godt nok for en demo; i produksjon er
 * dette en tabell i Postgres/Supabase med samme form.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Samtale } from "../agent/samtale.ts";
import { maskerPersonopplysninger } from "../innsikt/risiko.ts";

export function lagSamtaleLogg(dir: string) {
  mkdirSync(dir, { recursive: true });
  const trygg = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "");

  return {
    /** Fødselsnumre maskeres før noe skrives til disk. */
    lagre(s: Samtale) {
      const fil = join(dir, `${trygg(s.id)}.json`);
      const tidligere = existsSync(fil) ? JSON.parse(readFileSync(fil, "utf8")) : {};
      const data = s.tilJSON();
      const maskert = JSON.parse(maskerPersonopplysninger(JSON.stringify(data)));
      writeFileSync(fil, JSON.stringify({ ...maskert, oppsummering: tidligere.oppsummering }, null, 2));
    },
    oppdater(id: string, felt: Record<string, unknown>) {
      const fil = join(dir, `${trygg(id)}.json`);
      if (!existsSync(fil)) return;
      writeFileSync(fil, JSON.stringify({ ...JSON.parse(readFileSync(fil, "utf8")), ...felt }, null, 2));
    },
    hent(id: string) {
      const fil = join(dir, `${trygg(id)}.json`);
      return existsSync(fil) ? JSON.parse(readFileSync(fil, "utf8")) : null;
    },
    liste() {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
        .map((s) => {
          const agent = s.turer.filter((t: { rolle: string }) => t.rolle === "agent");
          const ms = agent.flatMap((t: { maling?: { totalMs: number } }) => (t.maling ? [t.maling.totalMs] : []));
          return {
            id: s.id,
            startet: s.startet,
            status: s.status,
            turer: s.turer.length,
            verktoy: agent.flatMap((t: { verktoy?: { navn: string }[] }) => (t.verktoy ?? []).map((v) => v.navn)),
            snittMs: ms.length ? Math.round(ms.reduce((a: number, b: number) => a + b, 0) / ms.length) : null,
            overforingsnotat: s.overforingsnotat,
            profil: s.profil?.navn,
            flagg: (s.flagg ?? []).map((f: { kode: string }) => f.kode),
            utfall: s.oppsummering?.utfall,
          };
        })
        .sort((a, b) => (a.startet < b.startet ? 1 : -1));
    },
  };
}
