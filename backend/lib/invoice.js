const PDFDocument = require("pdfkit");

function fmtDate(d) { return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }); }
function rand(n) { return `R${Number(n || 0).toFixed(2)}`; }

/**
 * Builds an invoice PDF for a confirmed booking and returns it as a
 * Buffer. Kept simple and clean rather than trying to exactly match
 * the booking widget's branding — a PDF invoice just needs to be clear
 * and correct.
 */
function generateInvoice(booking, unitName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const invoiceNumber = `WV-${booking.id.slice(0, 8).toUpperCase()}`;

    // Header
    doc.fontSize(20).fillColor("#4A4436").text("Welverdiend Accommodation", { continued: false });
    doc.fontSize(10).fillColor("#66604F")
      .text("4 Kenilworth Road")
      .text("079 118 3173  ·  bookings@welverdiendaccommodation.com");
    doc.moveDown(1.5);

    doc.fontSize(16).fillColor("#2B2A26").text("Invoice", { continued: true })
      .fontSize(10).fillColor("#66604F").text(`   ${invoiceNumber}`, { align: "left" });
    doc.fontSize(10).fillColor("#66604F").text(`Issued ${fmtDate(new Date())}`);
    doc.moveDown(1);

    // Bill to
    doc.fontSize(11).fillColor("#2B2A26").text("Billed to:", { underline: false });
    doc.fontSize(10).fillColor("#66604F")
      .text(booking.guestName)
      .text(booking.email)
      .text(booking.phone);
    doc.moveDown(1);

    // Stay details
    doc.fontSize(11).fillColor("#2B2A26").text("Stay details:");
    doc.fontSize(10).fillColor("#66604F")
      .text(`${unitName}`)
      .text(`${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)} (${booking.nights} night${booking.nights === 1 ? "" : "s"})`);
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

    doc.fontSize(10).fillColor("#66604F")
      .text("Deposit paid", col1, afterItemsY + 28, { width: 380 })
      .text(rand(booking.depositAmount), col2, afterItemsY + 28, { width: 90, align: "right" });

    const balancePaid = booking.balanceStatus === "paid";
    doc.fillColor(balancePaid ? "#4B6B3C" : "#A3402F")
      .text(balancePaid ? "Balance paid" : "Balance due before check-in", col1, afterItemsY + 46, { width: 380 })
      .text(rand(booking.balanceAmount), col2, afterItemsY + 46, { width: 90, align: "right" });

    doc.moveDown(4);
    doc.fontSize(9).fillColor("#66604F").text(
      balancePaid
        ? "Paid in full. We look forward to hosting you."
        : "Thank you for your deposit. The remaining balance is due before check-in.",
      col1
    );

    doc.end();
  });
}

module.exports = { generateInvoice };
