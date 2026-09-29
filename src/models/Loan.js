const mongoose = require('mongoose');
const softVoid = require('./plugins/softVoid');

const LOAN_TYPES = ['standard', 'emergency'];
const LOAN_STATUSES = ['pending', 'active', 'cleared', 'rejected'];
const TERM_MONTHS = [2, 6, 12]; // emergency = 2; standard = 6 (<=200k) or 12 (>200k)

// KES amounts rounded to 2 decimals to avoid floating-point drift.
const round2 = (v) => (v == null ? v : Math.round(v * 100) / 100);
const money = (extra = {}) => ({ type: Number, min: 0, set: round2, ...extra });

const loanSchema = new mongoose.Schema(
  {
    member: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    loanType: { type: String, enum: LOAN_TYPES, required: true },

    principal: money({ required: true, min: 1 }),
    // Flat rate applied to the principal: 0.10 for standard, 0 for emergency.
    // Values are computed by loanService (Phase 2); the model only guards consistency.
    interestRate: { type: Number, required: true, min: 0, max: 1 },
    interestAmount: money({ required: true }),   // principal * interestRate, fixed upfront
    totalPayable: money({ required: true }),     // principal + interestAmount
    amountPaid: money({ default: 0 }),           // maintained by loan_repayment transactions

    termMonths: { type: Number, required: true, enum: TERM_MONTHS },

    status: { type: String, enum: LOAN_STATUSES, default: 'pending', index: true },
    applicationDate: { type: Date, default: Date.now },
    disbursedDate: { type: Date },
    dueDate: { type: Date },
    clearedDate: { type: Date },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },   // admin who captured the application
    disbursedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true, maxlength: 1000 }
  },
  { timestamps: true, optimisticConcurrency: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

loanSchema.plugin(softVoid);

// Derived, never stored, so it can't drift from amountPaid.
loanSchema.virtual('outstandingBalance').get(function () {
  return round2(Math.max(this.totalPayable - this.amountPaid, 0));
});

loanSchema.virtual('isOverdue').get(function () {
  return this.status === 'active' && !!this.dueDate && this.dueDate < new Date();
});

// Consistency safety net (business rules themselves live in loanService).
loanSchema.pre('validate', function () {
  if (this.loanType === 'emergency') {
    if (this.interestRate !== 0 || this.interestAmount !== 0) {
      this.invalidate('interestRate', 'Emergency loans carry 0% interest');
    }
    if (this.termMonths !== 2) this.invalidate('termMonths', 'Emergency loans must be repaid within 2 months');
  } else if (this.loanType === 'standard' && ![6, 12].includes(this.termMonths)) {
    this.invalidate('termMonths', 'Standard loans must have a 6 or 12 month term');
  }

  if (
    this.principal != null && this.interestAmount != null && this.totalPayable != null &&
    Math.abs(this.principal + this.interestAmount - this.totalPayable) > 0.005
  ) {
    this.invalidate('totalPayable', 'totalPayable must equal principal + interestAmount');
  }

  if (this.amountPaid > this.totalPayable) {
    this.invalidate('amountPaid', 'amountPaid cannot exceed totalPayable');
  }

  if (['active', 'cleared'].includes(this.status)) {
    if (!this.disbursedDate) this.invalidate('disbursedDate', 'disbursedDate is required once a loan is disbursed');
    if (!this.dueDate) this.invalidate('dueDate', 'dueDate is required once a loan is disbursed');
  }
  if (this.status === 'cleared' && this.totalPayable - this.amountPaid > 0.005) {
    this.invalidate('status', 'A loan cannot be cleared while a balance remains');
  }
});

loanSchema.index({ status: 1, dueDate: 1 });
loanSchema.index({ member: 1, status: 1 });
loanSchema.index({ isVoided: 1, createdAt: -1 });

const Loan = mongoose.model('Loan', loanSchema);
Loan.LOAN_TYPES = LOAN_TYPES;
Loan.LOAN_STATUSES = LOAN_STATUSES;

module.exports = Loan;