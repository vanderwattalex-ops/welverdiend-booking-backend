const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

function fmtDate(d) { return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }); }
function rand(n) { return `R${Number(n || 0).toFixed(2)}`; }

const LOGO_PATH = path.join(__dirname, "..", "public", "letterhead-logo.png");

/**
 * Builds an invoice/receipt PDF for a booking and returns it as a
 * Buffer. The document adapts to the booking's payment stage:
 *   - Not yet confirmed (status !== "confirmed")  -> "Invoice — Deposit
 *     Required", full total shown as outstanding.
 *   - Confirmed, balance not yet paid              -> "Invoice — Balance
 *     Due Before Check-In", deposit shown as paid, balance as due.
 *   - Confirmed, balance paid                        -> "Receipt — Paid
 *     in Full".
 */
function generateInvoice(booking, unitName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const invoiceNumber = `WV-${booking.id.slice(0, 8).toUpperCase()}`;
    const depositPaid = booking.status === "confirmed";
    const balancePaid = booking.balanceStatus === "paid";

    let docTitle, docSubtitle;
    if (!depositPaid) {
      docTitle = "Invoice";
      docSubtitle = "Deposit required to confirm this booking";
    } else if (!balancePaid) {
      docTitle = "Invoice";
      docSubtitle = "Booking confirmed — balance due before check-in";
    } else {
      docTitle = "Receipt";
      docSubtitle = "Paid in full";
    }

    // Header — real letterhead logo if available, falls back to plain
    // text so a missing/renamed logo file never breaks invoice generation.
    let headerBottom = 50;
    try {
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 50, 50, { width: 200 });
        headerBottom = 50 + 200 * (455 / 2042) + 14; // matches the logo's cropped aspect ratio
      } else {
        throw new Error("logo not found");
      }
    } catch (e) {
      doc.fontSize(20).fillColor("#4A4436").text("Welverdiend Accommodation");
      headerBottom = doc.y + 4;
    }
    doc.fontSize(9).fillColor("#66604F")
      .text("4 Kenilworth Road  ·  079 118 3173  ·  bookings@welverdiendaccommodation.com", 50, headerBottom);
    doc.moveTo(50, headerBottom + 16).lineTo(545, headerBottom + 16).strokeColor("#E5E0D2").stroke();

    doc.y = headerBottom + 32;
    doc.fontSize(18).fillColor("#2B2A26").text(docTitle);
    doc.fontSize(11).fillColor(balancePaid ? "#4B6B3C" : "#8A6A1F").text(docSubtitle);
    doc.fontSize(9).fillColor("#66604F").text(`${invoiceNumber}   ·   Issued ${fmtDate(new Date())}`);
    doc.moveDown(1);

    // Bill to
    doc.fontSize(11).fillColor("#2B2A26").text("Billed to:");
    doc.fontSize(10).fillColor("#66604F")
      .text(booking.guestName)
      .text(booking.email)
      .text(booking.phone);
    doc.moveDown(1);

    // Stay details
    doc.fontSize(11).fillColor("#2B2A26").text("Stay details:");
    doc.fontSize(10).fillColor("#66604F")
      .text(`${unitName}`)
      .text(`${fmtDate(booking.checkIn)} to ${fmtDate(booking.checkOut)} (${booking.nights} night${booking.nights === 1 ? "" : "s"})`);
    doc.moveDown(1);

    // Line items table
    doc.fontSize(11).fillColor("#2B2A26").text("Charges:");
    doc.moveDown(0.3);
    const tableTop = doc.y;
    const col1 = 50, col2 = 450;
    doc.fontSize(9).fillColor("#66604F");
    (booking.lineItems || []).forEach((li, i) => {
      const y = tableTop + i * 18;
      doc.text(li.label, col1, y, { width: 380 });
      doc.text(rand(li.amount), col2, y, { width: 90, align: "right" });
    });
    const afterItemsY = tableTop + (booking.lineItems || []).length * 18 + 6;
    doc.moveTo(col1, afterItemsY).lineTo(545, afterItemsY).strokeColor("#E5E0D2").stroke();

    doc.fontSize(11).fillColor("#2B2A26")
      .text("Total", col1, afterItemsY + 8, { width: 380 })
      .text(rand(booking.totalAmount), col2, afterItemsY + 8, { width: 90, align: "right" });

    doc.fontSize(10).fillColor(depositPaid ? "#4B6B3C" : "#8A6A1F")
      .text(depositPaid ? "Deposit paid" : "Deposit required now", col1, afterItemsY + 28, { width: 380 })
      .text(rand(booking.depositAmount), col2, afterItemsY + 28, { width: 90, align: "right" });

    doc.fillColor(balancePaid ? "#4B6B3C" : depositPaid ? "#A3402F" : "#66604F")
      .text(balancePaid ? "Balance paid" : depositPaid ? "Balance due before check-in" : "Balance (due before check-in)", col1, afterItemsY + 46, { width: 380 })
      .text(rand(booking.balanceAmount), col2, afterItemsY + 46, { width: 90, align: "right" });

    if (!depositPaid) {
      doc.fontSize(11).fillColor("#2B2A26")
        .text("Amount due now", col1, afterItemsY + 70, { width: 380 })
        .text(rand(booking.depositAmount), col2, afterItemsY + 70, { width: 90, align: "right" });
    }

    doc.moveDown(6);
    doc.fontSize(9).fillColor("#66604F").text(
      !depositPaid
        ? "Please pay the deposit above to confirm this booking. Full banking details were included in our email to you."
        : balancePaid
          ? "Paid in full. We look forward to hosting you."
          : "Thank you for your deposit. The remaining balance is due before check-in.",
      col1
    );

    doc.end();
  });
}

module.exports = { generateInvoice };
