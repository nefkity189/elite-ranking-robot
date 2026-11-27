const {FieldValue} = require('firebase-admin/firestore');

const distanceFields = new Map([[2.5, 'elo25'], [5, 'elo5'], [10, 'elo10']]);
const millis = value => value && typeof value.toMillis === 'function' ? value.toMillis() : NaN;

// Same history ID as the app and GitHub robot: concurrent deliveries cannot pay twice.
async function scoreFinish(db, missionId, uid) {
  const missionRef = db.doc(`missions/${missionId}`);
  const playerRef = missionRef.collection('players').doc(uid);
  const userRef = db.doc(`users/${uid}`);
  const historyRef = userRef.collection('competitionHistory').doc(missionId);
  return db.runTransaction(async tx => {
    const history = await tx.get(historyRef);
    if (history.exists) return {status:'already_scored'};
    const [race, player, user, season, gps] = await tx.getAll(
      missionRef, playerRef, userRef, db.doc('config/season'), missionRef.collection('gpsPrivate').doc(uid));
    if (![race, player, user, season, gps].every(doc => doc.exists)) return {status:'rejected', reason:'missing_evidence'};
    const r = race.data(), p = player.data(), u = user.data(), s = season.data(), g = gps.data();
    const field = distanceFields.get(r.distanceKm);
    const start = millis(r.startsAt), finish = millis(p.finishedAt);
    if (!field || p.withdrawnAt || !Number.isFinite(start) || !Number.isFinite(finish) ||
        !Number.isFinite(millis(p.startedAt)) || millis(p.startedAt) < start || millis(p.startedAt) > finish ||
        finish < start || finish > start + 3 * 3600_000 || r.playerCount < 2 ||
        !Number.isFinite(p.progressKm) || p.progressKm < r.distanceKm || p.progressKm > r.distanceKm + 0.3 ||
        !Number.isInteger(p.timeSec) || p.timeSec <= 0 || p.timeSec > (finish-start)/1000 + 10 ||
        p.progressKm * 1000 > p.timeSec * 7 + 20 || typeof p.sessionId !== 'string' ||
        p.sessionId.length < 16 || p.state !== r.state || !r.winnerUid ||
        !s.id || u.seasonId !== s.id || start < millis(s.startsAt) || start >= millis(s.endsAt) ||
        !Number.isFinite(millis(s.startsAt)) || !Number.isFinite(millis(s.endsAt)) ||
        millis(g.updatedAt) !== finish || !Array.isArray(g.points) || g.points.length < 1 || g.points.length > 5 ||
        !g.points.every(point => Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
          Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180 &&
          Number.isFinite(point.accuracy) && point.accuracy > 0 && point.accuracy <= 20 && Number.isInteger(point.capturedAtMs))) {
      return {status:'rejected', reason:'invalid_finish'};
    }
    if (typeof p.startPeerUid !== 'string' || p.startPeerUid === uid || p.startPeerUid.includes('/')) {
      return {status:'rejected', reason:'invalid_start_witness'};
    }
    const peer = await tx.get(missionRef.collection('players').doc(p.startPeerUid));
    if (!peer.exists || !Number.isFinite(millis(peer.get('startedAt'))) || millis(peer.get('startedAt')) > finish) {
      return {status:'rejected', reason:'second_runner_did_not_start'};
    }
    const points = r.winnerUid === uid ? 30 : 20;
    if (!['elo', field].every(key => Number.isSafeInteger(u[key] ?? 0) && (u[key] ?? 0) >= 0)) {
      return {status:'rejected', reason:'invalid_profile_points'};
    }
    tx.update(userRef, {elo:(u.elo ?? 0)+points, [field]:(u[field] ?? 0)+points, lastScoredMissionId:missionId});
    tx.create(historyRef, {points, distanceKm:r.distanceKm, finishedAt:p.finishedAt, seasonId:s.id,
      timeSec:p.timeSec, paceSecPerKm:p.timeSec/r.distanceKm, state:p.state,
      resultStatus:'validated', scoredAt:FieldValue.serverTimestamp()});
    tx.update(playerRef, {eloDelta:points, resultStatus:'validated'});
    return {status:'scored', points};
  });
}

module.exports = {scoreFinish};
