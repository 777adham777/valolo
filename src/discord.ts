import type { DiscordWebhookClient, DiscordWebhookPayload } from "./types.js";

export class DiscordWebhookPoster implements DiscordWebhookClient {
  private readonly webhookUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(webhookUrl: string, fetchImpl: typeof fetch = fetch) {
    this.webhookUrl = webhookUrl;
    this.fetchImpl = fetchImpl;
  }

  public async postMessage(payload: DiscordWebhookPayload): Promise<void> {
    const response = await withRetry(async () => this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }));

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed with ${response.status}: ${body}`);
    }
  }

  public async checkConnection(): Promise<void> {
    const response = await withRetry(async () => this.fetchImpl(this.webhookUrl, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }));

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook check failed with ${response.status}: ${body}`);
    }
  }
}

async function withRetry(request: () => Promise<Response>, attempts = 3): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request();
    if (!shouldRetry(response) || attempt === attempts) {
      return response;
    }

    lastResponse = response;
    await delay(getRetryDelayInMs(response, attempt));
  }

  return lastResponse ?? request();
}

function shouldRetry(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

function getRetryDelayInMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1000;
    }
  }

  return 500 * attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
