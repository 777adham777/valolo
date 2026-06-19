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
        const displayName = normalizeOptionalText(process.argv[5]);
        if (!riotId || !regionInput) {
          throw new Error("Usage : add-player <name#tag> <region> [displayName]");
        }

        await tracker.addPlayer(riotId, parseRegion(regionInput), displayName);
        console.log(`Joueur ${riotId} ajoute ou mis a jour sur ${regionInput}.`);
        break;
      }
      case "remove-player": {
        const riotId = process.argv[3];
        const regionInput = process.argv[4];
        if (!riotId || !regionInput) {
          throw new Error("Usage : remove-player <name#tag> <region>");
        }

        const removed = await tracker.removePlayer(riotId, parseRegion(regionInput));
        console.log(removed ? `${riotId} a ete retire du suivi.` : `Aucun joueur suivi trouve pour ${riotId} dans ${regionInput}.`);
        break;
      }
      case "rename-player": {
        const riotId = process.argv[3];
        const regionInput = process.argv[4];
        const displayName = normalizeOptionalText(process.argv[5]);
        if (!riotId || !regionInput) {
          throw new Error("Usage : rename-player <name#tag> <region> [displayName]");
        }

        const renamed = await tracker.renamePlayer(riotId, parseRegion(regionInput), displayName);
        console.log(renamed ? `${riotId} a ete renomme.` : `Aucun joueur suivi trouve pour ${riotId} dans ${regionInput}.`);
        break;
      }
      case "list-players": {
        const players = await tracker.listPlayers();
        if (players.length === 0) {
          console.log("Aucun joueur suivi.");
        } else {
          console.log(players.join("\n"));
        }
        break;
      }
      case "sync": {
        const result = await tracker.syncSnapshots();
        console.log(`${result.updatedPlayers} snapshot(s) de joueur mises a jour.`);
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
          process.exitCode = 1;
        }
        break;
      }
      case "leaderboard": {
        const result = await tracker.postDailyLeaderboard();
        console.log("Classement quotidien envoye.");
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
        }
        break;
      }
      case "latest-match": {
        const result = await tracker.postLatestTrackedMatch();
        console.log(result.posted ? "Dernier match suivi envoye." : "Aucun match recent a envoyer.");
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
        }
        break;
      }
      case "health": {
        const result = await tracker.checkHealth();
        console.log(`Health check termine. ${result.checkedPlayers} joueur(s) suivi(s).`);
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
          process.exitCode = 1;
        }
        break;
      }
      case "poll": {
        const result = await tracker.pollMatches();
        console.log(`${result.checkedPlayers} joueur(s) verifie(s), ${result.postedMatches} nouveau(x) resume(s) de match envoye(s).`);
        if (result.failures.length > 0) {
          console.error(result.failures.join("\n"));
          process.exitCode = 1;
        }
        break;
      }
      default:
        throw new Error(`Commande inconnue "${command}"`);
    }
  } finally {
    store.close();
  }
}

function printUsage(): void {
  console.error([
    "Usage :",
    "  add-player <name#tag> <region> [displayName]",
    "  remove-player <name#tag> <region>",
    "  rename-player <name#tag> <region> [displayName]",
    "  list-players",
    "  sync",
    "  leaderboard",
    "  latest-match",
    "  health",
    "  poll"
  ].join("\n"));
}

function normalizeOptionalText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
