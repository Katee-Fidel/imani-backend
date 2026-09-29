const mongoose = require('mongoose');

let warned = false;

/**
 * Runs fn(session) inside a MongoDB transaction (auto-retries transient errors, aborts on throw).
 * Because of retries, fn must re-read anything it needs inside the callback.
 * MONGO_TRANSACTIONS=off runs fn(null) with NO atomicity: development on standalone mongod only.
 */
module.exports = async function withTransaction(fn) {
  if (process.env.MONGO_TRANSACTIONS === 'off') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MONGO_TRANSACTIONS=off is not allowed in production');
    }
    if (!warned) {
      console.warn('[WARN] MONGO_TRANSACTIONS=off: multi-document writes are NOT atomic. Development only.');
      warned = true;
    }
    return fn(null);
  }
  return mongoose.connection.transaction((session) => fn(session));
};