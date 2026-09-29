const asyncHandler = require('../utils/asyncHandler');
const statementService = require('../services/statementService');
const pdfService = require('../services/pdfService');

const parseTypes = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const pdfHeaders = (res, filename) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
};

// @route GET /api/statements?year=&period=&types=a,b&format=pdf   (any role)
exports.getMasterContributionTable = asyncHandler(async (req, res) => {
  const { year, period, types, format } = req.query;
  const table = await statementService.getMasterContributionTable({ year, period, types: parseTypes(types) });

  if (format === 'pdf') {
    const scope = table.filter.period || table.filter.year || 'all';
    pdfHeaders(res, `master-contributions-${scope}.pdf`);
    return pdfService.streamMasterTablePdf(table, res);
  }
  res.json({ success: true, ...table });
});

// @route GET /api/statements/summary?year=   (any role: group aggregation)
exports.getGroupSummary = asyncHandler(async (req, res) => {
  const summary = await statementService.getGroupSummary({ year: req.query.year });
  res.json({ success: true, summary });
});

// @route GET /api/statements/:userId?from=&to=&year=   (any role: any member's statement)
exports.getMemberStatement = asyncHandler(async (req, res) => {
  const { from, to, year } = req.query;
  const statement = await statementService.getMemberStatement(req.params.userId, { from, to, year });
  res.json({ success: true, statement });
});

// @route GET /api/statements/:userId/pdf?from=&to=&year=   (any role)
exports.downloadStatementPdf = asyncHandler(async (req, res) => {
  const { from, to, year } = req.query;
  const statement = await statementService.getMemberStatement(req.params.userId, { from, to, year });
  pdfHeaders(res, `statement-${slug(statement.member.fullName)}-${year || 'all'}.pdf`);
  pdfService.streamMemberStatementPdf(statement, res);
});