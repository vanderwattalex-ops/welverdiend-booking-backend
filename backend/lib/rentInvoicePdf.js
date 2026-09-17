const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

/**
 * PDF for a long-term guest's running-account invoice (rent, metered
 * electricity, cleaning, firewood, payments received, and credits for
 * things the guest bought on the owner's behalf).
 *
 * Deliberately separate from lib/invoice.js: that one is built around a
 * short stay's nights, deposit and balance, while this is a free-form
 * list of lines where any quantity can be fractional (kWh) and any
 * price can be negative (a payment, a credit). The layout follows the
 * invoices this guest already received from the owner's previous
 * invoicing tool, so nothing looks different to him.
 */

const LOGO_PATH = path.join(__dirname, "..", "public", "letterhead-logo.png");

const BUSINESS = {
  name: ["Welverdiend", "Accommodation"],
  address: ["4 Kenilworth Road,", "Groenvlei,", "Bloemfontein, 9301", "0791183173"]
};

const PAGE = { left: 43, right: 552, bottom: 842 - 40 };
// Column edges: QTY | DESCRIPTION | UNIT PRICE | AMOUNT
const COLS = [43, 96, 333, 426, 552];
const PAD = 7;
const INK = "#1F1F1F";
const GRID = "#9A9A9A";
const SHADE = "#F2F2F2";

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// "16,000.00" / "-19,112.00"
function money(n) {
  const v = round2(n);
  const [whole, cents] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

// "R17,806.53" / "-R250.00"
function rands(n) {
  const s = money(n);
  return s.startsWith("-") ? `-R${s.slice(1)}` : `R${s}`;
}

// 364.8 stays 364.8, 4 stays 4 — no trailing zeros.
function qtyText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return String(Math.round(v * 1000) / 1000);
}

// "2026-08-25" -> "25/08/2026"
function dmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || "";
}

/**
 * The single source of truth for an invoice's figures — the route
 * layer stores what this returns, so the stored total and the printed
 * total can never disagree.
 */
function computeLines(lines) {
  const clean = (Array.isArray(lines) ? lines : []).map(l => {
    const qty = Number.isFinite(Number(l.qty)) ? Number(l.qty) : 0;
    // The amount is worked out from the price as printed (to the cent),
    // so qty × the printed price always equals the printed amount.
    const unitPrice = round2(l.unitPrice);
    return {
      qty,
      description: String(l.description || "").trim(),
      unitPrice,
      amount: round2(qty * unitPrice)
    };
  });
  // Summing the already-rounded line amounts (not the raw products) is
  // what makes the total always equal the sum of the printed rows.
  const total = round2(clean.reduce((sum, l) => sum + l.amount, 0));
  return { lines: clean, total };
}

function drawTableHeader(doc, y) {
  const h = 22;
  doc.rect(COLS[0], y, COLS[4] - COLS[0], h).fillAndStroke(SHADE, GRID);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
  const labels = ["QTY", "DESCRIPTION", "UNIT PRICE", "AMOUNT"];
  labels.forEach((label, i) => {
    doc.text(label, COLS[i], y + 7, { width: COLS[i + 1] - COLS[i], align: "center" });
  });
  for (let i = 1; i < 4; i++) {
    doc.moveTo(COLS[i], y).lineTo(COLS[i], y + h).strokeColor(GRID).stroke();
  }
  return y + h;
}

/**
 * @param invoice  { number, date, billTo: {name, phone, email, unit}, lines, reference }
 * @param settings { terms, bankDetails, popLine }
 * @returns Promise<Buffer>
 */
function generateRentInvoice(invoice, settings = {}) {
  return new Promise((resolve, reject) => {
    // The bottom margin must sit below PAGE.bottom: PDFKit silently starts
    // a new page for any text drawn past its own bottom margin, which
    // would split the layout at a point this code doesn't control.
    const doc = new PDFDocument({ size: "A4", margins: { top: 43, left: 43, right: 43, bottom: 20 } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.lineWidth(0.6);

    // ---- Header ------------------------------------------------------
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(16);
    doc.text(BUSINESS.name[0], 46, 62);
    doc.text(BUSINESS.name[1], 46, 80);
    doc.text("INVOICE", PAGE.left, 62, { width: PAGE.right - PAGE.left, align: "right" });

    // A missing logo file must never stop an invoice from generating.
    try {
      if (fs.existsSync(LOGO_PATH)) {
        const w = 130;
        doc.image(LOGO_PATH, PAGE.right - w, 118, { width: w });
      }
    } catch (e) { /* text header alone is fine */ }

    doc.font("Helvetica").fontSize(10);
    BUSINESS.address.forEach((line, i) => doc.text(line, PAGE.left, 122 + i * 14.5));

    // ---- Bill to / invoice meta --------------------------------------
    const metaY = 222;
    const billTo = invoice.billTo || {};
    doc.font("Helvetica-Bold").fontSize(10).text("Bill To", PAGE.left, metaY);
    doc.font("Helvetica");
    [billTo.name, billTo.phone, billTo.email, billTo.unit]
      .filter(v => v && String(v).trim())
      .forEach((line, i) => doc.text(String(line), PAGE.left, metaY + 17 + i * 14.5, { width: 280 }));

    const labelRight = 470;
    const meta = [["Invoice #", String(invoice.number ?? "")], ["Invoice Date", dmy(invoice.date)]];
    meta.forEach(([label, value], i) => {
      const y = metaY + i * 17;
      doc.font("Helvetica-Bold").text(label, 330, y, { width: labelRight - 330, align: "right" });
      doc.font("Helvetica").text(value, labelRight, y, { width: PAGE.right - labelRight, align: "right" });
    });

    // ---- Line items ----------------------------------------------------
    const { lines, total } = computeLines(invoice.lines);
    let y = drawTableHeader(doc, 318);

    doc.font("Helvetica").fontSize(9.5);
    for (const line of lines) {
      const descWidth = COLS[2] - COLS[1] - PAD * 2;
      const textH = doc.heightOfString(line.description || " ", { width: descWidth });
      const rowH = Math.max(20, textH + 10);

      // A row that won't fit starts a fresh page with the header repeated,
      // so a long invoice stays readable on every page.
      if (y + rowH > PAGE.bottom) {
        doc.addPage();
        doc.lineWidth(0.6);
        y = drawTableHeader(doc, 50);
        doc.font("Helvetica").fontSize(9.5);
      }

      doc.rect(COLS[0], y, COLS[4] - COLS[0], rowH).strokeColor(GRID).stroke();
      for (let i = 1; i < 4; i++) {
        doc.moveTo(COLS[i], y).lineTo(COLS[i], y + rowH).strokeColor(GRID).stroke();
      }
      const ty = y + (rowH - textH) / 2 + 1;
      const midY = y + rowH / 2 - 4;
      doc.fillColor(INK);
      doc.text(qtyText(line.qty), COLS[0], midY, { width: COLS[1] - COLS[0], align: "center" });
      doc.text(line.description, COLS[1] + PAD, ty, { width: descWidth });
      doc.text(money(line.unitPrice), COLS[2], midY, { width: COLS[3] - COLS[2] - PAD, align: "right" });
      doc.text(money(line.amount), COLS[3], midY, { width: COLS[4] - COLS[3] - PAD, align: "right" });
      y += rowH;
    }

    // ---- Total ---------------------------------------------------------
    const totalH = 30;
    if (y + totalH + 4 > PAGE.bottom) { doc.addPage(); doc.lineWidth(0.6); y = 50; }
    doc.rect(COLS[3], y, COLS[4] - COLS[3], totalH).fillAndStroke(SHADE, GRID);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(14);
    doc.text("TOTAL", COLS[2], y + 9, { width: COLS[3] - COLS[2] - PAD, align: "right" });
    doc.text(rands(total), COLS[3], y + 9, { width: COLS[4] - COLS[3] - PAD, align: "right" });
    y += totalH + 18;

    // ---- Terms, banking, POP --------------------------------------------
    // Terms and banking sit side by side so that a normal month's invoice
    // fits on one page, with the account details on the same page as the
    // amount owed. The whole block is kept together: if it won't fit
    // under the table it moves to the next page intact, rather than
    // splitting the banking details across two pages.
    const fullWidth = PAGE.right - PAGE.left;
    const colW = 240;
    const rightX = PAGE.right - colW;
    const terms = (settings.terms || "").trim();
    const bank = (settings.bankDetails || "").trim();
    const reference = (invoice.reference || "").trim();
    const pop = (settings.popLine || "").trim();
    const bankLines = [bank, reference ? `Reference - ${reference}` : ""].filter(Boolean).join("\n");

    const columns = [];
    if (terms) columns.push({ heading: "Terms & Conditions", body: terms });
    if (bankLines) columns.push({ heading: "Banking Details:", body: bankLines });

    doc.fontSize(10);
    const colHeight = c =>
      doc.font("Helvetica-Bold").heightOfString(c.heading, { width: colW }) + 4 +
      doc.font("Helvetica").heightOfString(c.body, { width: colW, lineGap: 1.5 });
    const columnsH = columns.length ? Math.max(...columns.map(colHeight)) : 0;
    const popH = pop ? doc.font("Helvetica").heightOfString(pop, { width: fullWidth }) : 0;
    const blockH = columnsH + (pop ? 12 + popH : 0);

    if (y + blockH > PAGE.bottom) { doc.addPage(); y = 60; }

    doc.fillColor(INK);
    columns.forEach((c, i) => {
      const x = i === 0 ? PAGE.left : rightX;
      doc.font("Helvetica-Bold").text(c.heading, x, y, { width: colW });
      doc.font("Helvetica").text(c.body, x, doc.y + 4, { width: colW, lineGap: 1.5 });
    });
    if (pop) doc.font("Helvetica").text(pop, PAGE.left, y + columnsH + 12, { width: fullWidth });

    doc.end();
  });
}

module.exports = { generateRentInvoice, computeLines, money, rands, qtyText, dmy, round2 };
