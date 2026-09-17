const express = require("express");
const { v4: uuidv4 } = require("uuid");
const router = express.Router();
const { requireAdmin } = require("./adminAuth");
const { generateRentInvoice } = require("../lib/rentInvoicePdf");
const { sendRentInvoice } = require("../lib/email");
const {
  getRentSettings, saveRentSettings, claimInvoiceNumber,
  cleanInvoiceInput, buildNextDraft, rentInvoicesCollection
} = require("../lib/rentInvoices");

// -----------------------------------------------------------------
// Invoices for long-term guests — a free-form running account (rent,
// electricity, cleaning, firewood, payments, credits) that replaced the
// owner's previous invoicing tool. Nothing here touches bookings or the
// calendar.
//
// requireAdmin is applied per route, NOT with router.use(): a
// router-wide guard would intercept every /api request mounted after
// this file (see the note in server.js about admin.js).
// -----------------------------------------------------------------

function todaySA() {
  // Invoice dates are the owner's calendar day in South Africa, not UTC —
  // an invoice made at 01:00 SAST must not be dated yesterday.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
}

async function loadInvoice(id) {
  const doc = await rentInvoicesCollection.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// GET /api/admin/rent-invoices  -> every invoice (newest number first) + invoicing settings
router.get("/admin/rent-invoices", requireAdmin, async (req, res) => {
  try {
    const [snap, settings] = await Promise.all([rentInvoicesCollection.get(), getRentSettings()]);
    const invoices = snap.docs.map(d => d.data()).sort((a, b) => (b.number || 0) - (a.number || 0));
    res.json({ ok: true, invoices, settings, today: todaySA() });
  } catch (err) {
    console.error("[rent-invoices] list failed:", err);
    res.status(500).json({ ok: false, error: "Could not load invoices" });
  }
});

// POST /api/admin/rent-invoice-settings   body: { nextNumber?, terms?, bankDetails?, popLine? }
router.post("/admin/rent-invoice-settings", requireAdmin, async (req, res) => {
  try {
    await saveRentSettings(req.body || {});
    res.json({ ok: true, settings: await getRentSettings() });
  } catch (err) {
    if (err.userFacing) return res.status(400).json({ ok: false, error: err.message });
    console.error("[rent-invoices] save settings failed:", err);
    res.status(500).json({ ok: false, error: "Could not save invoice settings" });
  }
});

// POST /api/admin/rent-invoices   body: { date, billTo, lines, reference }
router.post("/admin/rent-invoices", requireAdmin, async (req, res) => {
  try {
    const { value, error } = cleanInvoiceInput(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    // The number is only claimed once the input is known to be valid, so
    // a rejected form never burns an invoice number.
    const number = await claimInvoiceNumber();
    const now = new Date().toISOString();
    const invoice = {
      id: uuidv4(),
      number,
      ...value,
      status: "unpaid",
      paidAt: null,
      sentAt: null,
      createdAt: now,
      updatedAt: now
    };
    await rentInvoicesCollection.doc(invoice.id).set(invoice);
    res.json({ ok: true, invoice });
  } catch (err) {
    console.error("[rent-invoices] create failed:", err);
    res.status(500).json({ ok: false, error: "Could not create that invoice" });
  }
});

// PUT /api/admin/rent-invoices/:id   body: { date, billTo, lines, reference }
// The invoice number never changes once issued.
router.put("/admin/rent-invoices/:id", requireAdmin, async (req, res) => {
  try {
    const existing = await loadInvoice(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: "Invoice not found" });
    const { value, error } = cleanInvoiceInput(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const updated = { ...existing, ...value, updatedAt: new Date().toISOString() };
    await rentInvoicesCollection.doc(existing.id).set(updated);
    res.json({ ok: true, invoice: updated });
  } catch (err) {
    console.error("[rent-invoices] update failed:", err);
    res.status(500).json({ ok: false, error: "Could not save that invoice" });
  }
});

// DELETE /api/admin/rent-invoices/:id
// The number is not handed out again — gaps in the sequence are normal
// and honest; reusing a number that may already have been sent is not.
router.delete("/admin/rent-invoices/:id", requireAdmin, async (req, res) => {
  try {
    await rentInvoicesCollection.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("[rent-invoices] delete failed:", err);
    res.status(500).json({ ok: false, error: "Could not delete that invoice" });
  }
});

// GET /api/admin/rent-invoices/:id/pdf
router.get("/admin/rent-invoices/:id/pdf", requireAdmin, async (req, res) => {
  try {
    const invoice = await loadInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
    const buffer = await generateRentInvoice(invoice, await getRentSettings());
    const safeName = String(invoice.billTo && invoice.billTo.name || "invoice").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.number}-${safeName}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error("[rent-invoices] pdf failed:", err);
    res.status(500).json({ ok: false, error: "Could not generate the PDF" });
  }
});

// POST /api/admin/rent-invoices/:id/send  -> emails the PDF to the guest
router.post("/admin/rent-invoices/:id/send", requireAdmin, async (req, res) => {
  try {
    const invoice = await loadInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
    if (!invoice.billTo || !invoice.billTo.email) {
      return res.status(400).json({ ok: false, error: "This invoice has no email address. Add one with Edit, or download the PDF and send it yourself." });
    }
    const settings = await getRentSettings();
    const pdf = await generateRentInvoice(invoice, settings);
    const result = await sendRentInvoice(invoice, settings, pdf);
    if (result.sent) {
      await rentInvoicesCollection.doc(invoice.id).update({ sentAt: new Date().toISOString() });
    }
    res.json({ ok: true, sent: result.sent, reason: result.reason || null, to: invoice.billTo.email });
  } catch (err) {
    console.error("[rent-invoices] send failed:", err);
    res.status(500).json({ ok: false, error: "Could not send that invoice" });
  }
});

// POST /api/admin/rent-invoices/:id/status   body: { paid: true|false }
router.post("/admin/rent-invoices/:id/status", requireAdmin, async (req, res) => {
  try {
    const invoice = await loadInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
    const paid = !!(req.body && req.body.paid);
    const update = {
      status: paid ? "paid" : "unpaid",
      paidAt: paid ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };
    await rentInvoicesCollection.doc(invoice.id).update(update);
    res.json({ ok: true, invoice: { ...invoice, ...update } });
  } catch (err) {
    console.error("[rent-invoices] status change failed:", err);
    res.status(500).json({ ok: false, error: "Could not update that invoice" });
  }
});

// GET /api/admin/rent-invoices/:id/next-draft
// A pre-filled (unsaved) next invoice based on this one — see
// buildNextDraft for how the previous period and payment carry over.
router.get("/admin/rent-invoices/:id/next-draft", requireAdmin, async (req, res) => {
  try {
    const invoice = await loadInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
    res.json({ ok: true, draft: buildNextDraft(invoice, todaySA()) });
  } catch (err) {
    console.error("[rent-invoices] next draft failed:", err);
    res.status(500).json({ ok: false, error: "Could not prepare the next invoice" });
  }
});

module.exports = router;
