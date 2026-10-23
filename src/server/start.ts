import { config } from "../config.ts";
import { anthropicKlient } from "../agent/samtale.ts";
import { startServer } from "./main.ts";
import { elevenLabsTale } from "../tale/elevenlabs.ts";

const s = await startServer({
  llm: anthropicKlient(),
  port: config.port,
  legacyPort: config.legacyPort,
  dataDir: config.dataDir,
  dashbordToken: config.dashbordToken,
  lagTale: config.elevenlabsKey
    ? elevenLabsTale({ apiKey: config.elevenlabsKey, stemme: config.elevenlabsStemme, modell: config.elevenlabsModell })
    : undefined,
});
console.log(`Agent-kvalitetsvakt kjører på ${s.url.replace("127.0.0.1", "localhost")}`);
console.log(`  Dashbord:        ${s.url.replace("127.0.0.1", "localhost")}/dashbord`);
console.log(`  Legacy booking:  ${s.legacyUrl}`);
console.log(`  Modell:          ${config.model} (effort ${config.effort})`);
console.log(`  Stemme:          ${config.elevenlabsKey ? `ElevenLabs (${config.elevenlabsModell})` : "nettleserens (sett ELEVENLABS_API_KEY for ekte stemme)"}`);
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) console.warn("  ADVARSEL: ANTHROPIC_API_KEY mangler, agenten vil ikke kunne svare.");
