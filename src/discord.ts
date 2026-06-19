import type { DiscordWebhookClient, DiscordWebhookPayload } from "./types.js";

export class DiscordWebhookPoster implements DiscordWebhookClient {
  private readonly webhookUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(webhookUrl: string, fetchImpl: typeof fetch = fetch) {
    this.webhookUrl = webhookUrl;
    this.fetchImpl = fetchImpl;
  }

  public async postMessage(payload: DiscordWebhookPayload): Promise<void> {
    const response = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed with ${response.status}: ${body}`);
    }
  }
}
