const mongoose = require('mongoose');
const User = require('../models/User');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const httpError = require('../utils/httpError');
const { CONTRIBUTION_TYPES, FINE_TYPES, TYPE_LABELS } = require('../utils/constants');

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const sum = (arr, fn = (x) => x) => round2(arr.reduce((s, x) => s + fn(x), 0));

function toObjectId(id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(400, 'Invalid member id');
  return new mongoose.Types.ObjectId(id);
}

function parseYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw httpError(400, 'Invalid year');
  return y;
}

/** Date range for statements. `to` is EXCLUSIVE. `year` overrides from/to. */
function resolveRange({ from, to, year } = {}) {
  if (year != null && year !== '') {
    const y = parseYear(year);
    return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) };
  }
  const range = {};
  if (from) {
    const d = new Date(from);
    if (isNaN(d)) throw httpError(400, 'Invalid from date');
    range.from = d;
  }
  if (to) {
    const d = new Date(to);
    if (isNaN(d)) throw httpError(400, 'Invalid to date');
    range.to = d;
  }
  return range;
}

// ---------------------------------------------------------------------------
// Master contribution table (group-wide, member x contribution type / month)
// ---------------------------------------------------------------------------

/** Pure shaping step (unit-testable without a database). */
function shapeMasterTable({ users, aggRows, types, filter }) {
  const rows = new Map();
  users.forEach((u) =>
    rows.set(String(u._id), {
      member: { id: String(u._id), fullName: u.fullName, status: u.status, role: u.role },
      byType: Object.fromEntries(types.map((t) => [t, 0])),
      byPeriod: {},
      total: 0
    })
  );

  const periods = new Set();
  for (const r of aggRows) {
    const row = rows.get(String(r._id.member));
    if (!row) continue;
    row.byType[r._id.type] = (row.byType[r._id.type] || 0) + r.total;
    if (r._id.period) {
      row.byPeriod[r._id.period] = (row.byPeriod[r._id.period] || 0) + r.total;
      periods.add(r._id.period);
    }
    row.total += r.total;
  }

  const list = [...rows.values()]
    .filter((r) => r.member.status === 'active' || r.total > 0) // hide dormant members with no history
    .map((r) => ({
      ...r,
      byType: Object.fromEntries(Object.entries(r.byType).map(([k, v]) => [k, round2(v)])),
      byPeriod: Object.fromEntries(Object.entries(r.byPeriod).map(([k, v]) => [k, round2(v)])),
      total: round2(r.total)
    }))
    .sort((a, b) => a.member.fullName.localeCompare(b.member.fullName));

  const grandTotals = {
    byType: Object.fromEntries(types.map((t) => [t, sum(list, (r) => r.byType[t])])),
    total: sum(list, (r) => r.total)
  };

  return {
    filter,
    columns: types.map((t) => ({ key: t, label: TYPE_LABELS[t] })),
    periods: [...periods].sort(),
    rows: list,
    grandTotals
  };
}

/**
 * Master contribution table. Filter by `period` (YYYY-MM) or `year`; optionally restrict `types`.
 * Voided transactions are always excluded.
 */
async function getMasterContributionTable({ year, period, types } = {}) {
  const useTypes = types && types.length ? types : CONTRIBUTION_TYPES;
  const invalid = useTypes.filter((t) => !CONTRIBUTION_TYPES.includes(t));
  if (invalid.length) throw httpError(400, `Unsupported contribution type(s): ${invalid.join(', ')}`);

  const match = { isVoided: false, type: { $in: useTypes } };
  if (period) {
    if (!PERIOD_RE.test(period)) throw httpError(400, 'period must be in YYYY-MM format');
    match.period = period;
  } else if (year != null && year !== '') {
    match.period = { $regex: `^${parseYear(year)}-` };
  }

  const [aggRows, users] = await Promise.all([
    Transaction.aggregate([
      { $match: match },
      { $group: { _id: { member: '$member', type: '$type', period: '$period' }, total: { $sum: '$amount' } } }
    ]),
    User.find({}).select('fullName status role').lean()
  ]);

  return shapeMasterTable({
    users, aggRows, types: useTypes,
    filter: { year: year ? Number(year) : null, period: period || null }
  });
}

// ---------------------------------------------------------------------------
// Individual member statement
// ---------------------------------------------------------------------------

/** Pure shaping step. */
function shapeMemberStatement({ user, transactions, loans, range }) {
  const entries = transactions.map((t) => ({
    id: String(t._id),
    date: t.paymentDate,
    type: t.type,
    label: TYPE_LABELS[t.type] || t.type,
    period: t.period || null,
    amount: round2(t.amount),
    method: t.paymentMethod,
    reference: t.reference || null,
    loanId: t.loan ? String(t.loan._id || t.loan) : null
  }));

  const totalsByType = {};
  entries.forEach((e) => { totalsByType[e.type] = round2((totalsByType[e.type] || 0) + e.amount); });

  const loanRows = loans.map((l) => ({
    id: String(l._id),
    loanType: l.loanType,
    principal: l.principal,
    interestAmount: l.interestAmount,
    totalPayable: l.totalPayable,
    amountPaid: l.amountPaid,
    outstanding: round2(Math.max(l.totalPayable - l.amountPaid, 0)),
    status: l.status,
    disbursedDate: l.disbursedDate,
    dueDate: l.dueDate
  }));

  return {
    // Contact details intentionally omitted: statements are visible group-wide.
    member: { id: String(user._id), fullName: user.fullName, status: user.status, joinedDate: user.joinedDate },
    range,
    generatedAt: new Date(),
    entries,
    totalsByType,
    loans: loanRows,
    summary: {
      contributionsTotal: sum(CONTRIBUTION_TYPES, (t) => totalsByType[t] || 0),
      finesPaidTotal: sum(FINE_TYPES, (t) => totalsByType[t] || 0),
      loanRepaymentsTotal: totalsByType.loan_repayment || 0,
      activeLoans: loanRows.filter((l) => l.status === 'active').length,
      outstandingLoanBalance: sum(loanRows.filter((l) => l.status === 'active'), (l) => l.outstanding)
    }
  };
}

/** Any member's statement (global read). Options: { from, to, year }. */
async function getMemberStatement(userId, opts = {}) {
  const id = toObjectId(userId);
  const user = await User.findById(id).select('fullName status joinedDate').lean();
  if (!user) throw httpError(404, 'Member not found');

  const range = resolveRange(opts);
  const match = { member: id, isVoided: false };
  if (range.from || range.to) {
    match.paymentDate = {};
    if (range.from) match.paymentDate.$gte = range.from;
    if (range.to) match.paymentDate.$lt = range.to;
  }

  const [transactions, loans] = await Promise.all([
    Transaction.find(match).sort({ paymentDate: 1, createdAt: 1 }).lean(),
    Loan.find({ member: id, isVoided: false, status: { $in: ['active', 'cleared'] } }).sort({ disbursedDate: 1 }).lean()
  ]);

  return shapeMemberStatement({ user, transactions, loans, range });
}

// ---------------------------------------------------------------------------
// Group summary (dashboard / group aggregation)
// ---------------------------------------------------------------------------

async function getGroupSummary({ year } = {}) {
  const range = resolveRange({ year });
  const txMatch = { isVoided: false };
  if (range.from) txMatch.paymentDate = { $gte: range.from, $lt: range.to };

  const [byType, loanBook, activeMembers] = await Promise.all([
    Transaction.aggregate([{ $match: txMatch }, { $group: { _id: '$type', total: { $sum: '$amount' } } }]),
    Loan.aggregate([
      { $match: { isVoided: false, status: 'active' } },
      {
        $group: {
          _id: null,
          activeLoans: { $sum: 1 },
          principal: { $sum: '$principal' },
          totalPayable: { $sum: '$totalPayable' },
          amountPaid: { $sum: '$amountPaid' },
          overdue: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, 1, 0] } }
        }
      }
    ]),
    User.countDocuments({ status: 'active' })
  ]);

  const totals = Object.fromEntries(byType.map((r) => [r._id, round2(r.total)]));
  const lb = loanBook[0] || { activeLoans: 0, principal: 0, totalPayable: 0, amountPaid: 0, overdue: 0 };

  return {
    year: year ? Number(year) : null,
    activeMembers,
    totalsByType: totals,
    contributionsTotal: sum(CONTRIBUTION_TYPES, (t) => totals[t] || 0),
    finesTotal: sum(FINE_TYPES, (t) => totals[t] || 0),
    loanRepaymentsTotal: totals.loan_repayment || 0,
    loanBook: {
      activeLoans: lb.activeLoans,
      overdueLoans: lb.overdue,
      principalOutstandingBook: round2(lb.principal),
      totalPayable: round2(lb.totalPayable),
      amountPaid: round2(lb.amountPaid),
      outstanding: round2(lb.totalPayable - lb.amountPaid)
    }
  };
}

module.exports = {
  getMasterContributionTable, getMemberStatement, getGroupSummary,
  shapeMasterTable, shapeMemberStatement, resolveRange
};