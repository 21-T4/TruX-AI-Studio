'use strict';

const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');

const db = () => getFirestore();
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const makeKey = () => 'trux-' + crypto.randomBytes(30).toString('base64url');
const today = () => new Date().toISOString().slice(0, 10);

// Only a SHA-256 hash of each API key is stored. The full key is shown to its owner once.
async function issueKey(uid, profile, { rotate }) {
  const users = db().collection('users');
  const keys = db().collection('apiKeys');
  return db().runTransaction(async (tx) => {
    const ref = users.doc(uid);
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    if (data.keyHash && !rotate) return { key: null, prefix: data.keyPrefix || '' };

    const key = makeKey();
    const hash = sha(key);
    if (data.keyHash) tx.delete(keys.doc(data.keyHash));
    tx.set(keys.doc(hash), { uid, createdAt: Date.now() });
    tx.set(ref, {
      uid,
      email: profile.email || '',
      displayName: profile.displayName || '',
      keyHash: hash,
      keyPrefix: key.slice(0, 13),
      createdAt: data.createdAt || Date.now(),
      keyCreatedAt: Date.now()
    }, { merge: true });
    return { key, prefix: key.slice(0, 13) };
  });
}

const ensureKey = (uid, profile) => issueKey(uid, profile, { rotate: false });
const rotateKey = (uid, profile) => issueKey(uid, profile, { rotate: true });

async function uidForKey(key) {
  if (typeof key !== 'string' || key.length < 20 || key.length > 120) return null;
  const snap = await db().collection('apiKeys').doc(sha(key)).get();
  return snap.exists ? snap.data().uid : null;
}

function limitError(model) {
  const err = new Error('Daily limit reached for ' + model.name + ' (' + model.dailyLimit +
    ' requests per day). It resets at 00:00 UTC.');
  err.status = 429;
  err.expose = true;
  return err;
}

async function consume(uid, model) {
  const ref = db().collection('usage').doc(uid + '_' + today());
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const counts = (snap.exists && snap.data().counts) || {};
    const used = counts[model.key] || 0;
    if (model.dailyLimit && used >= model.dailyLimit) throw limitError(model);
    tx.set(ref, { uid, day: today(), counts: { [model.key]: used + 1 }, updatedAt: Date.now() }, { merge: true });
    return { used: used + 1, limit: model.dailyLimit };
  });
}

async function refund(uid, model) {
  const ref = db().collection('usage').doc(uid + '_' + today());
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = ((snap.exists && snap.data().counts) || {})[model.key] || 0;
    if (used > 0) tx.set(ref, { counts: { [model.key]: used - 1 } }, { merge: true });
  });
}

async function usageToday(uid) {
  const snap = await db().collection('usage').doc(uid + '_' + today()).get();
  return (snap.exists && snap.data().counts) || {};
}

module.exports = { ensureKey, rotateKey, uidForKey, consume, refund, usageToday, today };
