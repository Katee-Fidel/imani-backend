const User = require('../models/User');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const httpError = require('../utils/httpError');
const withTransaction = require('../utils/withTransaction');
const loanService = require('./loanService');
const { assertObjectId, parseDate } = require('../utils/controllerHelpers');
const { TYPE_LABELS } = require('../utils/constants');
const mongoose = require('mongoose');

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ALLOCATIONS = 20;
const MAX_AMOUNT = 50000000;

// Christmas has a hard minimum (rejected below it). The others have a fixed expected monthly amount:
// a different amount is accepted but reported back as a warning, since part-payments happen.
const CONTRIBUTION_RULES = Object.freeze({
  christmas_contrib: { min: 2000 },
  retreat_contrib: { expected: 3000 },
  office_contrib: { expected: 500 },
  sitting_allowance: { expected: 500 },
  fine_late_shares: { expected: 500 }
});

/**
 * Validates and normalizes the split of one received payment. Pure (no DB), so it is unit-testable.
 * defaults.period is inherited only by types that require a period.
 */
function normalizeAllocations(raw, defaults = {}) {
  if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'At least one allocation is required');
  if (raw.length > MAX_ALLOCATIONS) throw httpError(400, `A payment can have at most ${MAX_ALLOCATIONS} allocations`);

  const seen = new Set();
  const warnings = [];
  const allocations = raw.map((r, i) => {
    const at = `allocations[${i}]`;
    if (!r || typeof r !== 'object') throw httpError(400, `${at} must be an object`);

    if (!Transaction.TYPES.includes(r.type)) throw httpError(400, `${at}.type must be one of: ${Transaction.TYPES.join(', ')}`);
    const type = r.type;

    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw httpError(400, `${at}.amount must be a positive number`);
    const amt = round2(amount);

    let period = r.period;
    if (period === undefined && Transaction.PERIOD_REQUIRED.includes(type)) period = defaults.period;
    if (period !== undefined && !PERIOD_RE.test(String(period))) throw httpError(400, `${at}.period must be in YYYY-MM format`);
    if (Transaction.PERIOD_REQUIRED.includes(type) && !period) throw httpError(400, `${at}: period (YYYY-MM) is required for ${type}`);

    let loan;
    if (Transaction.LOAN_LINKED.includes(type)) {
      if (!r.loan) throw httpError(400, `${at}: loan is required for ${type}`);
      loan = assertObjectId(r.loan, `${at}.loan`);
    } else if (r.loan) {
      throw httpError(400, `${at}: ${type} cannot be linked to a loan`);
    }

    const key = [type, period || '', loan || ''].join('|');
    if (seen.has(key)) throw httpError(400, `${at} duplicates another allocation (same type, period and loan); combine them`);
    seen.add(key);

    const rule = CONTRIBUTION_RULES[type];
    if (rule && rule.min && amt < rule.min) throw httpError(400, `${TYPE_LABELS[type]} must be at least KES ${rule.min}`);
    if (rule && rule.expected && amt !== rule.expected) {
      warnings.push(`${TYPE_LABELS[type]}: expected KES ${rule.expected}, received KES ${amt}`);
    }

    return { type, amount: amt, period: period || undefined, loan };
  });

  return { allocations, warnings, total: round2(allocations.reduce((s, a) => s + a.amount, 0)) };
}

/**
 * Records one received payment as N ledger rows and updates loan balances, all in ONE transaction:
 * either every row and every loan update is saved, or none.
 */
async function recordPayment(input, admin) {
  const { member, paymentMethod = 'mpesa', reference, notes } = input;
  assertObjectId(member, 'member');
  if (!Transaction.PAYMENT_METHODS.includes(paymentMethod)) {
    throw httpError(400, `paymentMethod must be one of: ${Transaction.PAYMENT_METHODS.join(', ')}`);
  }
  if (reference !== undefined && (typeof reference !== 'string' || reference.length > 100)) throw httpError(400, 'reference must be a string of at most 100 characters');
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 500)) throw httpError(400, 'notes must be a string of at most 500 characters');

  const paymentDate = parseDate(input.paymentDate, 'paymentDate') || new Date();
  if (paymentDate.getTime() > Date.now() + 24 * 3600 * 1000) throw httpError(400, 'paymentDate cannot be in the future');

  const { allocations, warnings, total } = normalizeAllocations(input.allocations, { period: input.period });

  const owner = await User.findById(member).select('status');
  if (!owner) throw httpError(404, 'Member not found');

  const paymentId = new mongoose.Types.ObjectId();

  const { created, touchedLoans } = await withTransaction(async (session) => {
    const loans = new Map();
    for (const id of new Set(allocations.filter((a) => a.loan).map((a) => a.loan))) {
      const loan = await Loan.findById(id).session(session);
      if (!loan || loan.isVoided) throw httpError(404, `Loan ${id} not found`);
      if (String(loan.member) !== String(member)) throw httpError(400, `Loan ${id} does not belong to this member`);
      loans.set(id, loan);
    }

    const touched = new Set();
    for (const a of allocations) {
      if (a.type === 'loan_repayment') {
        loanService.applyPayment(loans.get(a.loan), a.amount, paymentDate); // validates status + overpayment
        touched.add(a.loan);
      } else if (a.type === 'fine_late_loan') {
        const status = loans.get(a.loan).status;
        if (!['active', 'cleared'].includes(status)) throw httpError(409, `A loan fine can only be recorded against a disbursed loan (status: ${status})`);
      }
    }

    for (const id of touched) await loans.get(id).save({ session });

    const docs = allocations.map((a) => ({
      member, loan: a.loan, type: a.type, amount: a.amount, period: a.period,
      paymentDate, paymentMethod, reference, notes, recordedBy: admin._id, paymentId
    }));
    const createdDocs = await Transaction.create(docs, { session, ordered: true });
    return { created: createdDocs, touchedLoans: [...touched].map((id) => loans.get(id)) };
  });

  return {
    paymentId,
    member,
    paymentDate,
    total,
    transactions: created,
    loans: touchedLoans.map((l) => ({ id: l._id, status: l.status, amountPaid: l.amountPaid, outstandingBalance: l.outstandingBalance })),
    warnings
  };
}

/**
 * Soft-voids transactions matching `filter` ({ _id } or { paymentId }) atomically.
 * Voiding a loan_repayment also reverses its effect on the loan balance/status.
 */
async function voidTransactions(filter, reason, admin) {
  return withTransaction(async (session) => {
    const rows = await Transaction.find(filter).session(session);
    if (!rows.length) throw httpError(404, 'Transaction not found');
    const live = rows.filter((r) => !r.isVoided);
    if (!live.length) throw httpError(409, 'Already voided');

    const loans = new Map();
    for (const row of live) {
      if (row.type !== 'loan_repayment') continue;
      const key = String(row.loan);
      if (!loans.has(key)) {
        const loan = await Loan.findById(row.loan).session(session);
        if (!loan) throw httpError(409, 'Linked loan no longer exists');
        loans.set(key, loan);
      }
      loanService.reversePayment(loans.get(key), row.amount);
    }

    for (const row of live) {
      row.voidRecord(admin._id, reason);
      await row.save({ session });
    }
    for (const loan of loans.values()) await loan.save({ session });

    return { voided: live.length, transactions: live };
  });
}

module.exports = { CONTRIBUTION_RULES, normalizeAllocations, recordPayment, voidTransactions };