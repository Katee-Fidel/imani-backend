const CONTRIBUTION_TYPES = ['shares_savings', 'christmas_contrib', 'retreat_contrib', 'office_contrib', 'sitting_allowance'];
const FINE_TYPES = ['fine_late_loan', 'fine_late_shares'];

const TYPE_LABELS = {
  shares_savings: 'Shares / Savings',
  loan_repayment: 'Loan Repayment',
  christmas_contrib: 'Christmas Contribution',
  retreat_contrib: 'Retreat Contribution',
  office_contrib: 'Office Contribution',
  sitting_allowance: 'Sitting Allowance',
  fine_late_loan: 'Fine: Late Loan Clearance',
  fine_late_shares: 'Fine: Late Shares Banking'
};

// Compact headers for wide tables (master contribution table).
const TYPE_SHORT_LABELS = {
  shares_savings: 'Shares/Savings',
  christmas_contrib: 'Christmas',
  retreat_contrib: 'Retreat',
  office_contrib: 'Office',
  sitting_allowance: 'Sitting Allow.'
};

module.exports = { CONTRIBUTION_TYPES, FINE_TYPES, TYPE_LABELS, TYPE_SHORT_LABELS };