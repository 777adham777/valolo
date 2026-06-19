import { loadConfig, parseRegion } from "./config.js";
import { TrackerStore } from "./db.js";
import { DiscordWebhookPoster } from "./discord.js";
import { HenrikDevProvider } from "./providers/henrikdev.js";
import { TrackerService } from "./tracker.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const store = await TrackerStore.open({
    url: config.tursoDatabaseUrl,
    authToken: config.tursoAuthToken
  });
  const provider = new HenrikDevProvider({
    apiKey: config.henrikDevApiKey
  });
  const webhook = new DiscordWebhookPoster(config.discordWebhookUrl);
  const tracker = new TrackerService(store, provider, webhook);

  try {
    switch (command) {
      case "add-player": {
        const riotId = process.argv[3];
        const regionInput = process.argv[4];
        const displayName = process.argv[5] ?? null;
        if (!riotId || !regionInput) {
          throw new Error("Usage: add-player <name#tag> <region> [displayName]");
        }

        await tracker.addPlayer(riotId, parseRegion(regionInput), displayName);
        console.log(`Added or updated tracked player ${riotId} in ${regionInput}.`);
        break;
      }
      case "remove-player": {
        const riotId = process.argv[3];
        const regionInput = process.argv[4];
        if (!riotId || !regionInput) {
          throw new Error("Usage: remove-player <name#tag> <region>");
        }

        const removed = await tracker.removePlayer(riotId, parseRegion(regionInput));
        console.log(removed ? `Removed ${riotId} from tracking.` : `No tracked player found for ${riotId} in ${regionInput}.`);
        break;
      }
      case "list-players": {
        const players = await tracker.listPlayers();
        if (players.length === 0) {
          console.log("No tracked players.");
        } else {
          console.log(players.join("\n"));
        }
        break;
      }
      case "sync": {
        const result = await tracker.syncSnapshots();
        console.log(`Updated ${result.updatedPlayers} player snapshots.`);
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
          process.exitCode = 1;
        }
        break;
      }
      case "leaderboard": {
        const result = await tracker.postDailyLeaderboard();
        console.log("Posted daily leaderboard.");
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
        }
        break;
      }
      case "poll": {
        const result = await tracker.pollMatches();
        console.log(`Checked ${result.checkedPlayers} players and posted ${result.postedMatches} new match summaries.`);
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
          process.exitCode = 1;
        }
        break;
      }
      default:
        throw new Error(`Unknown command "${command}"`);
    }
  } finally {
    store.close();
  }
}

function printUsage(): void {
  console.error([
    "Usage:",
    "  add-player <name#tag> <region> [displayName]",
    "  remove-player <name#tag> <region>",
    "  list-players",
    "  sync",
    "  leaderboard",
    "  poll"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
