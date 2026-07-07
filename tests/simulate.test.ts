import { describe, expect, it } from "vitest";
import { runFeatureSimulation } from "../src/simulate.js";
import type { DiscordWebhookClient, DiscordWebhookPayload } from "../src/types.js";

class RecordingWebhook implements DiscordWebhookClient {
  public readonly payloads: DiscordWebhookPayload[] = [];

  public async postMessage(payload: DiscordWebhookPayload): Promise<void> {
    this.payloads.push(payload);
  }

  public async checkConnection(): Promise<void> {}
}

function allText(payloads: DiscordWebhookPayload[]): string {
  return payloads
    .flatMap((payload) => [
      payload.content ?? "",
      ...(payload.embeds ?? []).map((embed) => JSON.stringify(embed))
    ])
    .join("\n");
}

describe("runFeatureSimulation", () => {
  it("posts a message for every feature without touching real data", async () => {
    const webhook = new RecordingWebhook();

    await runFeatureSimulation(webhook);

    expect(webhook.payloads.length).toBeGreaterThan(15);

    const text = allText(webhook.payloads);

    // Leaderboard
    expect(text).toContain("Leaderboard Quotidien");
    expect(text).toContain("Radiant");

    // Punchlines (une par scenario dedie)
    expect(text).toContain("GG pour l'ACE");
    expect(text).toContain("1v9");
    expect(text).toContain("porté sa team");
    expect(text).toContain("choke");
    expect(text).toContain("sniper");
    expect(text).toContain("viser les pieds");
    expect(text).toContain("temps mort");
    expect(text).toContain("duelliste");
    expect(text).toContain("aimant à balles");
    expect(text).toContain("rotules");
    expect(text).toContain("score de combat à deux chiffres");
    expect(text).toContain("REMONTADA");
    expect(text).toContain("2 ACES");
    expect(text).toContain("smurf");
    expect(text).toContain("sac à dos");
    expect(text).toContain("minutes de match");
    expect(text).toContain("pliée en 18 minutes");
    expect(text).toContain("se disputent la dernière place");

    // Match commun
    expect(text).toContain("Match commun · 3 joueurs suivis");

    // Changements de rang
    expect(text).toContain("terminé ses placements");
    expect(text).toContain("est monté");
    expect(text).toContain("est retombé");

    // Series
    expect(text).toContain("victoires d'affilée");
    expect(text).toContain("défaites d'affilée");
    expect(text).toContain("10+");

    // Ceremonie hebdomadaire
    expect(text).toContain("MVP de la semaine");
    expect(text).toContain("Boulet de la semaine");
    expect(text).toContain("Le Sniper");
    expect(text).toContain("Le Fantôme");
    expect(text).toContain("No-Life");
  }, 20000);
});
