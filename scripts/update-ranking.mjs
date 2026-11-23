// Atualiza somente resultados confirmados. A transacao e o historico tornam cada premio idempotente.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const DRY = process.env.DRY_RUN === "1";
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? 6);
const MIN_AGE_MIN = Number(process.env.MIN_AGE_MIN ?? 8);
const CLOSE_AFTER_HOURS = 3 + 10 / 60;

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ?? "null");
if (!serviceAccount) throw new Error("Falta o segredo FIREBASE_SERVICE_ACCOUNT");
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const seasonRef = db.collection("config").doc("season");

function distanceField(distanceKm) {
  if (distanceKm === 2.5) return "elo25";
  if (distanceKm === 5) return "elo5";
  if (distanceKm === 10) return "elo10";
  throw new Error(`Distancia invalida: ${distanceKm}`);
}

async function scorePlayer(missionRef, mission, playerDoc, seasonId) {
  const uid = playerDoc.id;
  const userRef = db.collection("users").doc(uid);
  const historyRef = userRef.collection("competitionHistory").doc(missionRef.id);
  const points = mission.winnerUid === uid ? 30 : 20;
  const field = distanceField(mission.distanceKm);

  if (DRY) {
    console.log(`  ${uid}: ${points} pontos`);
    return;
  }

  await db.runTransaction(async (tx) => {
    const [player, user, history] = await Promise.all([
      tx.get(playerDoc.ref), tx.get(userRef), tx.get(historyRef),
    ]);
    if (history.exists || !user.exists || !player.get("finishedAt") || player.get("withdrawnAt")) return;
    if (user.get("seasonId") !== seasonId) return;

    tx.update(userRef, {
      elo: (user.get("elo") ?? 0) + points,
      [field]: (user.get(field) ?? 0) + points,
      lastScoredMissionId: missionRef.id,
    });
    tx.set(historyRef, {
      points,
      distanceKm: mission.distanceKm,
      finishedAt: player.get("finishedAt"),
      seasonId,
    });
    tx.update(playerDoc.ref, { eloDelta: points });
  });
}

async function processMission(missionDoc, seasonId) {
  const mission = missionDoc.data();
  if (mission.rankingProcessedAt) return "ja processada";
  const players = await missionDoc.ref.collection("players").get();
  const started = players.docs.filter((doc) => doc.get("startedAt"));
  if (started.length < 2) return "menos de 2 largaram";

  const closed = mission.startsAt.toMillis() <= Date.now() - CLOSE_AFTER_HOURS * 3_600_000;
  if (!closed && started.some((doc) => !doc.get("finishedAt") && !doc.get("withdrawnAt"))) return "ainda em andamento";

  const finished = started.filter((doc) => doc.get("finishedAt") && !doc.get("withdrawnAt"));
  for (const player of finished) await scorePlayer(missionDoc.ref, mission, player, seasonId);
  if (!DRY) await missionDoc.ref.update({ rankingProcessedAt: FieldValue.serverTimestamp() });
  return `ok (${finished.length} chegadas)`;
}

const season = await seasonRef.get();
if (!season.exists || !season.get("id")) throw new Error("Temporada atual ausente em config/season");
const now = Date.now();
const since = Timestamp.fromMillis(now - WINDOW_HOURS * 3_600_000);
const until = Timestamp.fromMillis(now - MIN_AGE_MIN * 60_000);
const missions = await db.collection("missions")
  .where("startsAt", ">=", since)
  .where("startsAt", "<=", until)
  .get();

console.log(`${DRY ? "[SIMULACAO] " : ""}${missions.size} missoes na janela`);
for (const mission of missions.docs) {
  try {
    console.log(mission.id, "->", await processMission(mission, season.get("id")));
  } catch (error) {
    console.error(mission.id, "FALHOU:", error.message);
    process.exitCode = 1;
  }
}
