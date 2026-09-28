const crypto = require("crypto");
const { bookingsCollection } = require("../lib/db");
const { generateInvoice } = require("../lib/invoice");
const { units } = require("../config/units");

// -----------------------------------------------------------------
// Shareable invoice link, for sending a booking over WhatsApp — where a
// wa.me link can't carry an attachment, so the message carries a link
// to the PDF instead.
//
// The only other way to the invoice is the admin endpoint, and that
// needs ADMIN_TOKEN, which opens the whole dashboard — it must never go
// in a message to a guest. This key is scoped to ONE booking and opens
// nothing else: the worst a leaked link can do is show that one invoice
// to whoever holds it, which is the guest it was sent to.
//
// Derived from ADMIN_TOKEN, so there's nothing to store or rotate — but
// changing ADMIN_TOKEN invalidates every invoice link already sent.
// (Same design as the Kenilworth Storages invoice app.)
// -----------------------------------------------------------------

function invoiceLinkKey(bookingId) {
  const secret = process.env.ADMIN_TOKEN || "";
  return crypto.createHmac("sha256", secret)
    .update(`welverdiend-invoice:${String(bookingId || "").trim()}`)
    .digest("base64url").slice(0, 22);
}

function verifyInvoiceLinkKey(bookingId, key) {
  if (!process.env.ADMIN_TOKEN || typeof key !== "string") return false;
  const expected = Buffer.from(invoiceLinkKey(bookingId));
  const given = Buffer.from(key);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// GET /i/:id/:key  -> the guest's invoice PDF, generated fresh each time,
// so it always shows where the booking is up to now (deposit due,
// confirmed, paid in full).
async function invoicePage(req, res) {
  const { id, key } = req.params;
  if (!verifyInvoiceLinkKey(id, key)) return res.status(404).type("text").send("This invoice link isn't valid.");
  try {
    const doc = await bookingsCollection.doc(id).get();
    if (!doc.exists) return res.status(404).type("text").send("This invoice link isn't valid.");
    const booking = doc.data();
    if (!["awaiting_payment", "submitted", "confirmed"].includes(booking.status)) {
      return res.status(410).type("text").send("This booking is no longer active, so its invoice isn't available. Please contact Welverdiend Accommodation.");
    }
    const unit = units.find(u => u.id === booking.unitId);
    const buffer = await generateInvoice(booking, unit ? unit.name : booking.unitId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Welverdiend-invoice-${booking.id.slice(0, 8)}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.send(buffer);
  } catch (err) {
    console.error("[invoiceLink] invoice generation failed:", err);
    res.status(500).type("text").send("Could not load the invoice right now — please try again shortly.");
  }
}

module.exports = { invoiceLinkKey, verifyInvoiceLinkKey, invoicePage };
