const express = require("express");
const router = express.Router();
const { bookingsCollection } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");
const { units } = require("../config/units");
const { notifyGuestCheckinReminder } = require("../lib/email");

function unitName(unitId) {
  const u = units.find(x => x.id === unitId);
  return u ? u.name : unitId;
}

function todayPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// GET /api/reminders/checkin
// Meant to be triggered once a day by Cloud Scheduler (same pattern as
// /api/sync). Emails every confirmed booking whose check-in is exactly
// 2 days away and hasn't already had this reminder sent, showing the
// amount paid so far and — if the balance is still unpaid — a nudge
// (with the payment link) to settle it before check-in.
router.get("/reminders/checkin", requireAdmin, async (req, res) => {
  try {
    const targetDate = todayPlusDays(2);
    const snap = await bookingsCollection.where("status", "==", "confirmed").get();
    const due = snap.docs
      .map(d => d.data())
      .filter(b => b.checkIn === targetDate && !b.checkinReminderSentAt);

    let sent = 0;
    for (const booking of due) {
      const result = await notifyGuestCheckinReminder(booking, unitName(booking.unitId));
      if (result.sent) {
        await bookingsCollection.doc(booking.id).update({ checkinReminderSentAt: new Date().toISOString() });
        sent++;
      }
    }

    res.json({ ok: true, targetDate, candidates: due.length, sent });
  } catch (err) {
    console.error("[reminders] checkin reminder run failed:", err);
    res.status(500).json({ ok: false, error: "Reminder run failed" });
  }
});

module.exports = router;
