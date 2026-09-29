const httpError = require('../utils/httpError');

// Single source of truth for loan rules (mirrors system-architecture.md).
const LOAN_RULES = Object.freeze({
  STANDARD_INTEREST_RATE: 0.10,     // flat, on principal
  EMERGENCY_INTEREST_RATE: 0,
  SHORT_TERM_MAX_PRINCIPAL: 200000, // principal <= this  -> 6 months
  SHORT_TERM_MONTHS: 6,
  LONG_TERM_MONTHS: 12,             // principal above the limit -> 12 months
  EMERGENCY_TERM_MONTHS: 2
});

const LOAN_TYPES = ['standard', 'emergency'];
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Repayment period in months for a loan type + principal. */
function getTermMonths(loanType, principal) {
  if (loanType === 'emergency') return LOAN_RULES.EMERGENCY_TERM_MONTHS;
  return principal <= LOAN_RULES.SHORT_TERM_MAX_PRINCIPAL ? LOAN_RULES.SHORT_TERM_MONTHS : LOAN_RULES.LONG_TERM_MONTHS;
}

/**
 * Validates inputs and computes the financial terms of a loan.
 * Returns exactly the fields the Loan model stores.
 */
function computeLoanTerms({ loanType, principal }) {
  if (!LOAN_TYPES.includes(loanType)) throw httpError(400, `loanType must be one of: ${LOAN_TYPES.join(', ')}`);
  const p = Number(principal);
  if (!Number.isFinite(p) || p <= 0) throw httpError(400, 'principal must be a positive number');

  const principalAmt = round2(p);
  const interestRate = loanType === 'emergency' ? LOAN_RULES.EMERGENCY_INTEREST_RATE : LOAN_RULES.STANDARD_INTEREST_RATE;
  const interestAmount = round2(principalAmt * interestRate);

  return {
    loanType,
    principal: principalAmt,
    interestRate,
    interestAmount,
    totalPayable: round2(principalAmt + interestAmount),
    termMonths: getTermMonths(loanType, principalAmt)
  };
}

/** Calendar-month addition in UTC, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

const computeDueDate = (disbursedDate, termMonths) => addMonths(disbursedDate, termMonths);

/**
 * Informational schedule: equal monthly instalments, last one absorbs rounding.
 * (The rules only fix the repayment period; the schedule is not enforced anywhere.)
 */
function buildRepaymentSchedule({ totalPayable, termMonths }, disbursedDate) {
  const base = Math.floor((totalPayable / termMonths) * 100) / 100;
  const schedule = [];
  let allocated = 0;
  for (let i = 1; i <= termMonths; i++) {
    const amount = i === termMonths ? round2(totalPayable - allocated) : base;
    allocated = round2(allocated + amount);
    schedule.push({ installment: i, dueDate: addMonths(disbursedDate, i), amount });
  }
  return schedule;
}

/** pending -> active. Mutates the doc; the caller saves it (inside a session if needed). */
function markDisbursed(loan, { disbursedBy, disbursedDate = new Date() } = {}) {
  if (loan.isVoided) throw httpError(409, 'Cannot disburse a voided loan');
  if (loan.status !== 'pending') throw httpError(409, `Only pending loans can be disbursed (current status: ${loan.status})`);
  loan.status = 'active';
  loan.disbursedDate = disbursedDate;
  loan.dueDate = computeDueDate(disbursedDate, loan.termMonths);
  loan.disbursedBy = disbursedBy;
  return loan;
}

/** Applies a repayment to an active loan; auto-clears it when fully paid. Caller saves. */
function applyPayment(loan, amount, paymentDate = new Date()) {
  if (loan.isVoided) throw httpError(409, 'Cannot repay a voided loan');
  if (loan.status !== 'active') throw httpError(409, `Loan is not active (status: ${loan.status})`);
  const a = round2(Number(amount));
  if (!Number.isFinite(a) || a <= 0) throw httpError(400, 'Payment amount must be a positive number');

  const outstanding = round2(loan.totalPayable - loan.amountPaid);
  if (a > outstanding) throw httpError(400, `Payment of ${a} exceeds outstanding balance of ${outstanding}`);

  loan.amountPaid = round2(loan.amountPaid + a);
  if (round2(loan.totalPayable - loan.amountPaid) === 0) {
    loan.status = 'cleared';
    loan.clearedDate = paymentDate;
  }
  return loan;
}

/** Reverses a repayment (used when a loan_repayment transaction is voided). Caller saves. */
function reversePayment(loan, amount) {
  const a = round2(Number(amount));
  if (!Number.isFinite(a) || a <= 0) throw httpError(400, 'Amount must be a positive number');
  if (a > loan.amountPaid) throw httpError(400, 'Reversal exceeds amount paid');
  loan.amountPaid = round2(loan.amountPaid - a);
  if (loan.status === 'cleared') {
    loan.status = 'active';
    loan.clearedDate = undefined;
  }
  return loan;
}

module.exports = {
  LOAN_RULES, LOAN_TYPES, round2,
  getTermMonths, computeLoanTerms, addMonths, computeDueDate,
  buildRepaymentSchedule, markDisbursed, applyPayment, reversePayment
};