const PDFDocument = require('pdfkit');
const { TYPE_LABELS, TYPE_SHORT_LABELS } = require('../utils/constants');

const COLORS = { ink: '#1a1a1a', muted: '#666666', head: '#1f3a5f', band: '#f3f5f8', line: '#d0d0d0' };
const MARGIN = 40;

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kes = (n) => `KES ${money(n)}`;
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const chamaNameOf = (opts = {}) => opts.chamaName || process.env.CHAMA_NAME || 'Chama Ledger';

function rangeLabel(range = {}) {
  if (!range.from && !range.to) return 'All time';
  const to = range.to ? fmtDate(new Date(range.to.getTime() - 86400000)) : 'today';
  return `${range.from ? fmtDate(range.from) : 'Beginning'} to ${to}`;
}

const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

function newDoc(title, chamaName, layout = 'portrait') {
  return new PDFDocument({
    size: 'A4', layout, margin: MARGIN, bufferPages: true,
    info: { Title: title, Author: chamaName, Producer: 'Chama Ledger' }
  });
}

function drawBanner(doc, chamaName, title, subtitle) {
  const left = doc.page.margins.left;
  const w = contentWidth(doc);
  doc.rect(left, MARGIN, w, 58).fill(COLORS.head);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
    .text(chamaName, left + 12, MARGIN + 10, { width: w - 24, lineBreak: false });
  doc.font('Helvetica').fontSize(10)
    .text(title, left + 12, MARGIN + 32, { width: w / 2, lineBreak: false })
    .text(subtitle, left + w / 2, MARGIN + 32, { width: w / 2 - 12, align: 'right', lineBreak: false });
  doc.fillColor(COLORS.ink);
  doc.x = left;
  doc.y = MARGIN + 74;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.head).text(text, doc.page.margins.left, doc.y);
  doc.moveDown(0.3);
  doc.fillColor(COLORS.ink);
}

function keyValues(doc, pairs) {
  const left = doc.page.margins.left;
  pairs.forEach(([k, v]) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(k, left, y, { width: 130, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.ink).text(String(v), left + 130, y, { width: contentWidth(doc) - 130, lineBreak: false });
    doc.y = y + 15;
  });
}

/** columns: [{ key, label, width, align?, format?(value,row) }]; row._bold renders bold. */
function drawTable(doc, { columns, rows, rowHeight = 18 }) {
  const x = doc.page.margins.left;
  const width = columns.reduce((s, c) => s + c.width, 0);

  const header = () => {
    const y = doc.y;
    doc.rect(x, y, width, rowHeight).fill(COLORS.head);
    let cx = x;
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
    columns.forEach((c) => {
      doc.text(c.label, cx + 4, y + 5, { width: c.width - 8, height: rowHeight - 6, align: c.align || 'left', ellipsis: true });
      cx += c.width;
    });
    doc.fillColor(COLORS.ink);
    doc.y = y + rowHeight;
  };

  ensureSpace(doc, rowHeight * 3);
  header();

  if (!rows.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.muted).text('No records for this selection.', x + 4, doc.y + 5);
    doc.fillColor(COLORS.ink);
    doc.y += 24;
    return;
  }

  rows.forEach((row, i) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      header();
    }
    const y = doc.y;
    if (i % 2 === 0) doc.rect(x, y, width, rowHeight).fill(COLORS.band);
    doc.fillColor(COLORS.ink).font(row._bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    let cx = x;
    columns.forEach((c) => {
      const raw = row[c.key];
      const text = c.format ? c.format(raw, row) : raw == null ? '-' : String(raw);
      doc.text(text, cx + 4, y + 5, { width: c.width - 8, height: rowHeight - 6, align: c.align || 'left', ellipsis: true });
      cx += c.width;
    });
    doc.y = y + rowHeight;
  });
  doc.moveDown(0.5);
  doc.x = x;
}

function addFooters(doc, chamaName) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow drawing inside the bottom margin without spawning a new page
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
      .text(`${chamaName}  |  Generated ${fmtDate(new Date())}  |  Page ${i + 1} of ${range.count}`,
        doc.page.margins.left, doc.page.height - 28, { width: contentWidth(doc), align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

/**
 * Official member statement. `statement` comes from statementService.getMemberStatement().
 * Pipes to `out` (e.g. an Express response) and ends the document.
 */
function streamMemberStatementPdf(statement, out, opts = {}) {
  const chamaName = chamaNameOf(opts);
  const { member, summary, totalsByType, loans, entries, range } = statement;
  const doc = newDoc(`Statement - ${member.fullName}`, chamaName);
  doc.pipe(out);

  drawBanner(doc, chamaName, 'Official Member Statement', `Period: ${rangeLabel(range)}`);
  keyValues(doc, [
    ['Member', member.fullName],
    ['Member ID', member.id],
    ['Status', member.status],
    ['Member since', fmtDate(member.joinedDate)]
  ]);

  sectionTitle(doc, 'Summary');
  drawTable(doc, {
    columns: [
      { key: 'k', label: 'Item', width: 315 },
      { key: 'v', label: 'Amount', width: 200, align: 'right', format: (v) => (typeof v === 'number' ? kes(v) : v) }
    ],
    rows: [
      { k: 'Total contributions', v: summary.contributionsTotal },
      { k: 'Loan repayments made', v: summary.loanRepaymentsTotal },
      { k: 'Fines paid', v: summary.finesPaidTotal },
      { k: 'Active loans', v: String(summary.activeLoans) },
      { k: 'Outstanding loan balance', v: summary.outstandingLoanBalance, _bold: true }
    ]
  });

  sectionTitle(doc, 'Totals by category');
  drawTable(doc, {
    columns: [
      { key: 'label', label: 'Category', width: 315 },
      { key: 'total', label: 'Total', width: 200, align: 'right', format: kes }
    ],
    rows: Object.entries(totalsByType).map(([t, total]) => ({ label: TYPE_LABELS[t] || t, total }))
  });

  sectionTitle(doc, 'Loans');
  drawTable(doc, {
    columns: [
      { key: 'loanType', label: 'Type', width: 60, format: (v) => (v ? v[0].toUpperCase() + v.slice(1) : '-') },
      { key: 'status', label: 'Status', width: 50 },
      { key: 'disbursedDate', label: 'Disbursed', width: 62, format: fmtDate },
      { key: 'dueDate', label: 'Due', width: 62, format: fmtDate },
      { key: 'principal', label: 'Principal', width: 70, align: 'right', format: money },
      { key: 'interestAmount', label: 'Interest', width: 60, align: 'right', format: money },
      { key: 'amountPaid', label: 'Paid', width: 70, align: 'right', format: money },
      { key: 'outstanding', label: 'Balance', width: 81, align: 'right', format: money }
    ],
    rows: loans
  });

  sectionTitle(doc, 'Transactions');
  drawTable(doc, {
    columns: [
      { key: 'date', label: 'Date', width: 60, format: fmtDate },
      { key: 'label', label: 'Type', width: 135 },
      { key: 'period', label: 'Period', width: 50 },
      { key: 'method', label: 'Method', width: 50 },
      { key: 'reference', label: 'Reference', width: 100 },
      { key: 'amount', label: 'Amount (KES)', width: 120, align: 'right', format: money }
    ],
    rows: entries
  });

  addFooters(doc, chamaName);
  doc.end();
  return doc;
}

/** Master contribution table (landscape). `table` comes from statementService.getMasterContributionTable(). */
function streamMasterTablePdf(table, out, opts = {}) {
  const chamaName = chamaNameOf(opts);
  const doc = newDoc('Master Contribution Table', chamaName, 'landscape');
  doc.pipe(out);

  const f = table.filter || {};
  const scope = f.period ? `Period ${f.period}` : f.year ? `Year ${f.year}` : 'All periods';
  drawBanner(doc, chamaName, 'Master Contribution Table', scope);

  const typeCols = table.columns.map((c) => ({
    key: c.key, label: TYPE_SHORT_LABELS[c.key] || c.label, width: 100, align: 'right', format: money
  }));
  const rows = table.rows.map((r) => ({ name: r.member.fullName, ...r.byType, total: r.total }));
  rows.push({ name: 'GROUP TOTAL', ...table.grandTotals.byType, total: table.grandTotals.total, _bold: true });

  drawTable(doc, {
    columns: [
      { key: 'name', label: 'Member', width: 762 - 100 * typeCols.length - 90 },
      ...typeCols,
      { key: 'total', label: 'Total', width: 90, align: 'right', format: money }
    ],
    rows
  });

  addFooters(doc, chamaName);
  doc.end();
  return doc;
}

module.exports = { streamMemberStatementPdf, streamMasterTablePdf };