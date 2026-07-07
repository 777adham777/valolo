import type { MatchSummaryPost } from "./types.js";

// Seuils anti-bruit : on ne juge pas la visee sur 3 balles ni un "aimant a balles" sur 1 round.
const MIN_HITS_FOR_AIM_JUDGEMENT = 15;
const SNIPER_HS_PERCENT = 35;
const LOW_HS_PERCENT = 10;
const CARRY_RATIO = 1.5;
const MIN_FIRST_DEATHS_FOR_MAGNET = 3;
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

  if (highlights.teamCarryRatio !== null && highlights.teamCarryRatio >= CARRY_RATIO) {
    pushOne(3, [
      `💪 ${name} a joué en 1v9 !`,
      `💪 ${name} a porté quatre valises pendant tout le match.`,
      `💪 ${name} a fait le match de sa vie pendant que les autres faisaient de la figuration.`
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

  if (highlights.teamChoked && post.didWin === false) {
    pushOne(9, [
      `🤡 Le plus grand choke de l'histoire. Vous avez réussi à perdre ça..`,
      `🤡 Un choke pareil, ça devrait être sanctionné par Riot.`,
      `🤡 Perdre avec cette avance, c'est presque un exploit.`
    ]);
  }

  if (matchMinutes !== null && post.didWin === false && matchMinutes < FAST_DEFEAT_MAX_MINUTES) {
    pushOne(10, [
      `⏱️ Défaite pliée en ${matchMinutes} minutes. Au moins ils n'ont pas fait durer la souffrance.`,
      `⏱️ ${matchMinutes} minutes. Le temps de préchauffer le four, c'était déjà fini.`,
      `⏱️ Défaite speedrun en ${matchMinutes} minutes. Catégorie Any%.`
    ]);
  }

  if (matchMinutes !== null && matchMinutes >= MARATHON_MIN_MINUTES) {
    pushOne(11, [
      `🛋️ ${matchMinutes} minutes de match. À ce stade ils habitent sur le serveur.`,
      `🛋️ Un match de ${matchMinutes} minutes. Facturez les heures sup.`,
      `🛋️ ${matchMinutes} minutes de match. Il y a des CDD plus courts.`
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
