const ical = require("ical-generator").default;

/**
 * Builds an .ics feed of a unit's CONFIRMED direct (EFT) bookings, so it can
 * be pasted as an "import calendar" URL into Airbnb / Booking.com /
 * Lekkeslaap. This is what closes the loop for two-way sync: a direct
 * booking here blocks the dates everywhere else too.
 */
function buildUnitExport(unitName, confirmedBookings) {
  const cal = ical({ name: `Welverdiend Accommodation — ${unitName}` });

  for (const b of confirmedBookings) {
    cal.createEvent({
      start: b.checkIn,
      end: b.checkOut,
      allDay: true,
      summary: "Booked (Welverdiend direct booking)",
      description: "Reserved via the Welverdiend Accommodation website — not for guest identifying details.",
      uid: b.id
    });
  }

  return cal.toString();
}

module.exports = { buildUnitExport };
