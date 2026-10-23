import { readFileSync, existsSync } from "node:fs";

// Minimal .env-lesing så prosjektet ikke trenger dotenv.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  model: process.env.MODEL ?? "claude-opus-5-5",
  // Telefon er latensfølsomt: lav effort gir korte, raske svar.
  effort: (process.env.EFFORT ?? "low") as Effort,
  simulatorModel: process.env.SIMULATOR_MODEL ?? process.env.MODEL ?? "claude-opus-5-5",
  judgeModel: process.env.JUDGE_MODEL ?? process.env.MODEL ?? "claude-opus-5-5",
  port: Number(process.env.PORT ?? 3000),
  legacyPort: Number(process.env.LEGACY_PORT ?? 4010),
  vapiSecret: process.env.VAPI_SECRET ?? "",
  /** Hvis satt, kreves ?token=… for dashbordets API og live-strømmen. */
  dashbordToken: process.env.DASHBORD_TOKEN ?? "",
  dataDir: process.env.DATA_DIR ?? "data",
  /** Valgfritt: ekte stemme i stedet for nettleserens. Uten nøkkel brukes nettleseren. */
  elevenlabsKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenlabsStemme: process.env.ELEVENLABS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL",
  elevenlabsModell: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
};
