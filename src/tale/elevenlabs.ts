/**
 * Talesyntese via ElevenLabs. Nettleserens innebygde stemme høres ut som en maskin,
 * så serveren lager lyden når en nøkkel er satt. Uten nøkkel faller klienten tilbake
 * til nettleseren.
 */
export type LagTale = (tekst: string) => Promise<Buffer>;

export interface ElevenLabsOptions {
  apiKey: string;
  stemme: string;
  /** Flash er laget for lav forsinkelse og kan norsk. */
  modell: string;
  fetchFn?: typeof fetch;
}

export function elevenLabsTale(o: ElevenLabsOptions): LagTale {
  const f = o.fetchFn ?? fetch;
  return async (tekst) => {
    const r = await f(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(o.stemme)}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": o.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: tekst,
        model_id: o.modell,
        language_code: "no",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`ElevenLabs svarte ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  };
}
