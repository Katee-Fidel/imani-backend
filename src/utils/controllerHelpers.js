const mongoose = require('mongoose');
const httpError = require('./httpError');

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

const assertObjectId = (v, label = 'id') => {
  if (!OBJECT_ID_RE.test(String(v))) throw httpError(400, `Invalid ${label}`);
  return String(v);
};

const toObjectId = (v, label) => new mongoose.Types.ObjectId(assertObjectId(v, label));

const requireReason = (v) => {
  const r = typeof v === 'string' ? v.trim() : '';
  if (r.length < 3) throw httpError(400, 'A reason (at least 3 characters) is required');
  if (r.length > 500) throw httpError(400, 'Reason must be 500 characters or fewer');
  return r;
};

const parseDate = (v, label = 'date') => {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  if (isNaN(d)) throw httpError(400, `Invalid ${label}`);
  return d;
};

const parsePagination = (q = {}, defaultLimit = 50, maxLimit = 200) => {
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

module.exports = { assertObjectId, toObjectId, requireReason, parseDate, parsePagination };