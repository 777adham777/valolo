import type { MatchSummaryPost } from "./types.js";

// Seuils anti-bruit : on ne juge pas la visee sur 3 balles ni un "aimant a balles" sur 1 round.
const MIN_HITS_FOR_AIM_JUDGEMENT = 15;
const SNIPER_HS_PERCENT = 35;
const LOW_HS_PERCENT = 10;
const CARRY_RATIO = 1.5;
const MIN_FIRST_DEATHS_FOR_MAGNET = 3;
const MIN_FIRST_BLOODS_FOR_ENTRY = 4;
const MIN_KILLS_FOR_FLAT_KD = 10;
const CLOSE_WIN_MAX_ROUND_GAP = 2;
// 13-0 ou 13-1, dans un sens comme dans l'autre.
const STOMP_MAX_LOSER_SCORE = 1;
const MIN_KILLS_FOR_LONE_WOLF = 15;
const MIN_KILLS_FOR_UNTOUCHABLE = 15;
const MAX_DEATHS_FOR_UNTOUCHABLE = 6;
// Touriste : quasi aucune participation aux combats sur une game complete.
const TOURIST_MAX_KILLS = 6;
const TOURIST_MAX_DEATHS = 8;
const TOURIST_MAX_ASSISTS = 3;
const TOURIST_MIN_ROUNDS = 16;
// 27 rounds et plus = prolongations a rallonge (le minimum en overtime est 14-12, 26 rounds).
const OVERTIME_MIN_TOTAL_ROUNDS = 27;
const MIN_LEGSHOTS_FOR_KNEECAPPER = 5;
const LOW_ADR = 60;
const GHOST_ACS = 100;
const SMURF_ACS = 400;
const FAST_DEFEAT_MAX_MINUTES = 20;
const MARATHON_MIN_MINUTES = 45;
const MAX_PUNCHLINES_PER_PLAYER = 3;

// Permet de forcer une variante (tests, simulation). Par defaut la variante est choisie
// par un hash de l'id du match : deterministe, donc identique pour tous les joueurs d'un
// meme match (les punchlines d'equipe restent dedupliquables) et variee d'un match a l'autre.
export type PunchlineVariantPicker = (variantCount: number) => number;

export function getPunchlines(post: MatchSummaryPost, pickVariant?: PunchlineVariantPicker): string[] {
  const name = post.playerDisplayName;
  const punchlines: string[] = [];
  const matchSeed = hashString(post.matchId);

  const pushOne = (salt: number, variants: string[]): void => {
    const index = pickVariant
      ? Math.min(Math.max(pickVariant(variants.length), 0), variants.length - 1)
      : (matchSeed + salt) % variants.length;
    punchlines.push(variants[index]!);
  };

  const totalHits = post.headshots !== null && post.bodyshots !== null && post.legshots !== null
    ? post.headshots + post.bodyshots + post.legshots
    : null;
  const hsPercent = totalHits !== null && totalHits > 0 ? (post.headshots! / totalHits) * 100 : null;
  const acs = post.score !== null && post.roundsPlayed !== null && post.roundsPlayed > 0
    ? post.score / post.roundsPlayed
    : null;
  const adr = post.damageDealt !== null && post.roundsPlayed !== null && post.roundsPlayed > 0
    ? post.damageDealt / post.roundsPlayed
    : null;
  const matchMinutes = post.gameLengthInMs !== null ? Math.round(post.gameLengthInMs / 60_000) : null;
  const acsRounded = acs !== null ? Math.round(acs) : null;
  const hsRounded = hsPercent !== null ? Math.round(hsPercent) : null;
  const adrRounded = adr !== null ? Math.round(adr) : null;
  const deaths = post.deaths ?? 0;
  const firstDeaths = post.highlights.firstDeaths ?? 0;
  const agentLabel = post.agentName ?? "un duelliste";
  const highlights = post.highlights;
  const scoreLine = post.teamScore !== null && post.opponentScore !== null
    ? `${post.teamScore}-${post.opponentScore}`
    : null;
  const totalRounds = post.teamScore !== null && post.opponentScore !== null
    ? post.teamScore + post.opponentScore
    : null;

  // Les positives d'abord, les tacles ensuite.
  if (highlights.aces >= 2) {
    pushOne(1, [
      `🔥 ${name} a claqué ${highlights.aces} ACES dans le même match. Faites-le signer avant qu'il demande une augmentation.`,
      `🔥 ${highlights.aces} ACES dans la même game. ${name} ne joue pas au même jeu que nous.`,
      `🔥 ${name} enchaîne les ACES comme d'autres enchaînent les défaites.`
    ]);
  } else if (highlights.aces === 1) {
    pushOne(2, [
      `🔥 ${name} GG pour l'ACE !`,
      `🔥 ${name} vient de nettoyer un round à lui tout seul. Propre.`,
      `🔥 ACE ! ${name} a éteint les 5 à lui tout seul.`,
      `🔥 Round nettoyé par ${name}. Personne n'a survécu pour raconter.`
    ]);
  }

  // Un 4K sans ace : on ne le mentionne pas si un ace a deja ete celebre juste au-dessus.
  if (highlights.aces === 0 && highlights.quadKills >= 1) {
    pushOne(20, [
      `💣 4 kills dans le round pour ${name}. L'ace était à une balle près.`
    ]);
  }

  if (highlights.teamCarryRatio !== null && highlights.teamCarryRatio >= CARRY_RATIO) {
    pushOne(3, [
      `💪 ${name} a joué en 1v9 !`,
      `💪 ${name} a porté quatre valises pendant tout le match.`,
      `💪 ${name} a fait le match de sa vie pendant que les autres faisaient de la figuration.`
    ]);
  }

  if (highlights.firstBloods !== null && highlights.firstBloods >= MIN_FIRST_BLOODS_FOR_ENTRY) {
    pushOne(21, [
      `⚡ ${highlights.firstBloods} first bloods. ${name} arrive sur le site avant le round.`,
      `⚡ ${name} dit bonjour en premier, et à balles réelles : ${highlights.firstBloods} first bloods.`
    ]);
  }

  if (acsRounded !== null && acsRounded >= SMURF_ACS) {
    pushOne(4, [
      `🚨 ${name} finit à ${acsRounded} d'ACS. Soit c'est un smurf, soit il faut le signaler à Riot. Peut-être les deux.`,
      `🚨 ${acsRounded} d'ACS. ${name}, rends ce compte à son vrai propriétaire.`,
      `🚨 ${name} à ${acsRounded} d'ACS. Le lobby a demandé un contrôle antidopage.`
    ]);
  }

  if (highlights.teamComeback && post.didWin === true) {
    pushOne(5, [
      `🔄 REMONTADA HISTORIQUE ! Ils étaient morts et enterrés, ils ont retourné le match.`,
      `🔄 Le match était plié. Quelqu'un a oublié de leur dire. REMONTADA.`,
      `🔄 Tout le monde avait abandonné ce match, sauf eux. REMONTADA.`
    ]);
  }

  // Prolongations a rallonge d'abord, sinon victoire arrachee (13-11 / overtime court) :
  // une seule blague sur le score serre. Phrases sans nom, dedupliquees dans les messages groupes.
  if (totalRounds !== null && totalRounds >= OVERTIME_MIN_TOTAL_ROUNDS) {
    pushOne(26, [
      `⏳ ${scoreLine} après prolongations. Ce match a duré plus longtemps que certaines relations.`
    ]);
  } else if (
    post.didWin === true
    && post.teamScore !== null
    && post.opponentScore !== null
    && post.teamScore >= 13
    && post.teamScore - post.opponentScore <= CLOSE_WIN_MAX_ROUND_GAP
  ) {
    pushOne(22, [
      `🫀 ${post.teamScore}-${post.opponentScore}. Ce match a coûté trois ans d'espérance de vie à tout le monde.`
    ]);
  }

  if (highlights.isBottomFragOfMatch && post.didWin === true) {
    pushOne(6, [
      `🎒 ${name} a gagné en étant dernier des 10. Porté de bout en bout comme un sac à dos.`,
      `🎒 Victoire pour ${name}, dernier du lobby. Le RR le plus gratuit de sa vie.`,
      `🎒 ${name} a gagné sans toucher son clavier. Remerciez l'équipe.`
    ]);
  }

  if (highlights.isTopScoreOfMatch && post.didWin === false) {
    pushOne(7, [
      `🫡 ${name} a porté sa team sur ses épaules, mais malheureusement, ça n'a pas suffi..`,
      `🫡 ${name} top score du match, pour rien. La défaite la plus injuste de la soirée.`,
      `🫡 ${name} a tout donné. Les autres ont regardé.`
    ]);
  }

  if (hsRounded !== null && totalHits !== null && totalHits >= MIN_HITS_FOR_AIM_JUDGEMENT && hsPercent! >= SNIPER_HS_PERCENT) {
    pushOne(8, [
      `🎯 ${name} est un sniper.`,
      `🎯 ${hsRounded}% de headshots. ${name} ne connaît pas le corps, seulement la tête.`,
      `🎯 ${name} avait la souris chirurgicale ce soir. Que des têtes.`
    ]);
  }

  if (
    post.kills !== null
    && post.deaths !== null
    && post.kills >= MIN_KILLS_FOR_UNTOUCHABLE
    && post.deaths <= MAX_DEATHS_FOR_UNTOUCHABLE
  ) {
    pushOne(24, [
      `🛡️ ${post.kills} kills pour seulement ${post.deaths} morts. ${name} était intouchable ce soir.`
    ]);
  }

  // Ecrasement 13-0 / 13-1 : phrase sans nom, dedupliquee dans les messages groupes.
  if (
    post.didWin === true
    && post.teamScore !== null
    && post.opponentScore !== null
    && post.teamScore >= 13
    && post.opponentScore <= STOMP_MAX_LOSER_SCORE
  ) {
    pushOne(25, [
      `🚂 ${scoreLine}. Ce n'était pas un match, c'était une démonstration.`,
      `🚂 ${scoreLine}. Même le spike n'a pas eu le temps de chauffer.`
    ]);
  }

  if (highlights.teamChoked && post.didWin === false) {
    pushOne(9, [
      `🤡 Le plus grand choke de l'histoire. Vous avez réussi à perdre ça..`,
      `🤡 Un choke pareil, ça devrait être sanctionné par Riot.`,
      `🤡 Perdre avec cette avance, c'est presque un exploit.`
    ]);
  }

  // Ecrasement subi 0-13 / 1-13 : phrase sans nom, dedupliquee dans les messages groupes.
  if (
    post.didWin === false
    && post.teamScore !== null
    && post.opponentScore !== null
    && post.opponentScore >= 13
    && post.teamScore <= STOMP_MAX_LOSER_SCORE
  ) {
    pushOne(27, [
      `🧱 ${scoreLine}. Les joueurs retournent au vestiaire en silence.`
    ]);
  }

  if (matchMinutes !== null && post.didWin === false && matchMinutes < FAST_DEFEAT_MAX_MINUTES) {
    pushOne(10, [
      `⏱️ Défaite pliée en ${matchMinutes} minutes. Au moins ils n'ont pas fait durer la souffrance.`,
      `⏱️ ${matchMinutes} minutes. Le temps de préchauffer le four, c'était déjà fini.`,
      `⏱️ Défaite speedrun en ${matchMinutes} minutes. Catégorie Any%.`
    ]);
  }

  // Le marathon s'efface derriere la blague overtime, qui raconte deja un match interminable.
  if (
    matchMinutes !== null
    && matchMinutes >= MARATHON_MIN_MINUTES
    && (totalRounds === null || totalRounds < OVERTIME_MIN_TOTAL_ROUNDS)
  ) {
    pushOne(11, [
      `🛋️ ${matchMinutes} minutes de match. À ce stade ils habitent sur le serveur.`,
      `🛋️ Un match de ${matchMinutes} minutes. Facturez les heures sup.`,
      `🛋️ ${matchMinutes} minutes de match. Il y a des CDD plus courts.`
    ]);
  }

  if (post.kills !== null && post.deaths !== null && post.kills === post.deaths && post.kills >= MIN_KILLS_FOR_FLAT_KD) {
    pushOne(23, [
      `⚖️ KD de 1.00 pile. ${name}, le fonctionnaire du serveur : ni plus, ni moins.`
    ]);
  }

  if (hsRounded !== null && totalHits !== null && totalHits >= MIN_HITS_FOR_AIM_JUDGEMENT && hsPercent! < LOW_HS_PERCENT) {
    pushOne(12, [
      `📐 ${name}, arrête de viser les pieds et monte ton viseur..`,
      `📐 ${hsRounded}% de HS. ${name} vise comme s'il jouait au trackpad.`,
      `📐 Le crosshair de ${name} est resté collé au sol tout le match.`
    ]);
  }

  if (highlights.isMostDeathsInMatch) {
    pushOne(13, [
      `⚰️ ${name} a passé plus de temps mort que vivant.`,
      `⚰️ ${deaths} morts. ${name} a passé le match en caméra spectateur.`,
      `⚰️ Mort ${deaths} fois. À ce stade ce n'est plus du courage, c'est de l'entêtement.`
    ]);
  }

  if (highlights.isDuelist && highlights.isBottomFragOfMatch) {
    pushOne(14, [
      `🗡️ ${name} n'aurait pas dû pick un duelliste, lamentable.`,
      `🗡️ ${name} a pris ${agentLabel} pour le style, visiblement pas pour les kills.`,
      `🗡️ ${name} instalock ${agentLabel} pour finir bottom frag. Le crime parfait.`
    ]);
  }

  if (
    highlights.firstBloods === 0
    && highlights.isMostFirstDeathsInMatch
    && highlights.firstDeaths !== null
    && highlights.firstDeaths >= MIN_FIRST_DEATHS_FOR_MAGNET
  ) {
    pushOne(15, [
      `🪦 ${name} est un aimant à balles. Premier mort du round à répétition, record du monde du speedrun spectateur.`,
      `🪦 ${firstDeaths} fois premier mort du round. ${name}, l'éclaireur sacrificiel.`,
      `🪦 ${name} ouvre chaque round en mourant. Technique audacieuse.`
    ]);
  }

  if (
    post.headshots !== null
    && post.legshots !== null
    && post.legshots >= MIN_LEGSHOTS_FOR_KNEECAPPER
    && post.legshots > post.headshots
  ) {
    pushOne(16, [
      `🦵 ${name} vise exclusivement les rotules. C'est un tueur à gages, mais de genoux.`,
      `🦵 ${name} a déclaré la guerre aux tibias.`,
      `🦵 ${name} a touché plus de jambes que de têtes. Le seul joueur qui vise les mollets.`
    ]);
  }

  if (
    post.kills !== null
    && post.assists !== null
    && post.assists === 0
    && post.kills >= MIN_KILLS_FOR_LONE_WOLF
  ) {
    pushOne(28, [
      `🐺 ${post.kills} kills, 0 assist. ${name} ne connaît pas ses coéquipiers, et c'est réciproque.`,
      `🐺 ${name} a fait sa game en silence radio : ${post.kills} kills, aucune assist.`
    ]);
  }

  if (
    post.kills !== null
    && post.deaths !== null
    && post.assists !== null
    && post.roundsPlayed !== null
    && post.roundsPlayed >= TOURIST_MIN_ROUNDS
    && post.kills <= TOURIST_MAX_KILLS
    && post.deaths <= TOURIST_MAX_DEATHS
    && post.assists <= TOURIST_MAX_ASSISTS
  ) {
    pushOne(29, [
      `🧳 ${name} a soigneusement évité tout contact avec l'ennemi. Belle visite de la carte.`,
      `🧳 ${name} a pris des screenshots du décor pendant que les autres jouaient.`
    ]);
  }

  // ACS < 100 et ADR < 60 racontent la meme game : on ne garde que la plus cinglante.
  if (acsRounded !== null && acs! < GHOST_ACS) {
    pushOne(17, [
      `👻 ${name} a fini avec un score de combat à deux chiffres. Le bot de l'entraînement fait plus de dégâts que lui.`,
      `👻 Les ennemis ont fini le match sans savoir que ${name} y était.`,
      `👻 ${acsRounded} d'ACS. ${name} était là, mais seulement sur le papier.`
    ]);
  } else if (adrRounded !== null && adr! < LOW_ADR) {
    pushOne(18, [
      `📉 ${name} a mis moins de 60 de dégâts par round. En gros, il mettait une balle de Classic et il s'en allait.`,
      `📉 ${adrRounded} de dégâts par round. ${name} tire à blanc.`,
      `📉 ${name} fait moins de dégâts qu'une spike qui explose dans le vide.`
    ]);
  }

  return punchlines.slice(0, MAX_PUNCHLINES_PER_PLAYER);
}

// Message de serie par palier : le ton s'emballe (victoires) ou empire (defaites) avec le compte.
// La variante est choisie par un hash du contexte : stable pour un meme evenement, variee entre
// joueurs et entre paliers.
export function getStreakMessage(
  displayName: string,
  kind: "win" | "loss",
  count: number,
  isOpenEnded: boolean,
  pickVariant?: PunchlineVariantPicker
): string {
  const name = `**${displayName}**`;
  const displayCount = isOpenEnded ? `${count}+` : `${count}`;

  const variants = kind === "win"
    ? count >= 5
      ? [
        `👑 ${displayCount} victoires d'affilée ! ${name} est officiellement INARRÊTABLE.`,
        `👑 ${name} : ${displayCount} wins de suite. Riot enquête, c'est trop propre.`
      ]
      : count === 4
        ? [
          `🚀 4 victoires d'affilée ! ${name} est en pleine ascension, ne le déconcentrez pas.`,
          `🚀 ${name} enchaîne 4 wins. Le smurf, c'est lui maintenant.`
        ]
        : [
          `🔥 ${name} enchaîne 3 victoires ! La machine est lancée.`,
          `🔥 3 de suite pour ${name}. Ça commence à sentir bon pour lui !`
        ]
    : count >= 5
      ? [
        `☠️ ${displayCount} défaites d'affilée. ${name}, c'est un naufrage.`
      ]
      : count === 4
        ? [
          `🚑 4 de suite. ${name} confond ranked et œuvre caritative : il distribue du RR.`
        ]
        : [
          `🧯 ${name} enchaîne 3 défaites. Une pause hydratation s'impose.`,
          `🧯 3 défaites de suite pour ${name}. C'est un début de tendance, pas encore un mode de vie.`,
          `🧯 3 défaites d'affilée pour ${name}, ressaisis-toi mon grand !`
        ];

  const index = pickVariant
    ? Math.min(Math.max(pickVariant(variants.length), 0), variants.length - 1)
    : hashString(`${displayName}:${kind}:${count}`) % variants.length;
  return variants[index]!;
}

// Punchline de groupe : plusieurs joueurs suivis dans les 3 pires scores du lobby.
export function getBottomDuoPunchline(names: string[], matchId: string, pickVariant?: PunchlineVariantPicker): string {
  const nameList = names.length > 1
    ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`
    : names[0] ?? "";
  const variants = [
    `🤡 ${nameList} se disputent la dernière place. Quelle rivalité !`,
    `🤡 ${nameList} au fond du classement, coude à coude. Le vrai match était là.`,
    `🤡 Duel au sommet... du bas de tableau : ${names.join(" contre ")}.`
  ];

  const index = pickVariant
    ? Math.min(Math.max(pickVariant(variants.length), 0), variants.length - 1)
    : (hashString(matchId) + 19) % variants.length;
  return variants[index]!;
}

function hashString(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
