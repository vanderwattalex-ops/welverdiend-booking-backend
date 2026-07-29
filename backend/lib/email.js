const nodemailer = require("nodemailer");
const { ownerNotificationEmail, bankDetails, frontendBaseUrl } = require("../config/units");

// Uses Gmail's SMTP with an "App Password" — set EMAIL_USER and
// EMAIL_APP_PASSWORD as environment variables (see README for how to
// generate an App Password). Works for a plain Gmail address or a Google
// Workspace address on your own domain.
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] EMAIL_USER / EMAIL_APP_PASSWORD not set — skipping email:", subject);
    return;
  }
  try {
    await t.sendMail({ from: `Welverdiend Accommodation <${process.env.EMAIL_USER}>`, to, subject, html });
  } catch (err) {
    // A failed email should never break the booking flow itself.
    console.error("[email] failed to send:", subject, err.message);
  }
}

function fmtDate(d) { return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }); }
function rand(n) { return `R${Number(n || 0).toFixed(2)}`; }

async function notifyOwnerNewRequest(booking, unitName) {
  await sendMail({
    to: ownerNotificationEmail,
    subject: `New booking request — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>A new booking request has come in and is waiting for your review.</p>
      <ul>
        <li><b>Unit:</b> ${unitName}</li>
        <li><b>Dates:</b> ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)} (${booking.nights} night${booking.nights === 1 ? "" : "s"})</li>
        <li><b>Guest:</b> ${booking.guestName} (${booking.email}, ${booking.phone})</li>
        <li><b>Guests:</b> ${booking.adults} adult${booking.adults === 1 ? "" : "s"}${booking.children ? `, ${booking.children} child${booking.children === 1 ? "" : "ren"}` : ""}</li>
        <li><b>Pets:</b> ${booking.hasPets ? (booking.petDetails || "Yes") : "No"}</li>
        <li><b>Total:</b> ${rand(booking.totalAmount)}</li>
      </ul>
      <p>Open your admin dashboard to approve or decline these dates.</p>
    `
  });
}

async function notifyGuestApproved(booking, unitName) {
  const uploadUrl = frontendBaseUrl
    ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}`
    : null;
  await sendMail({
    to: booking.email,
    subject: `Good news — your dates at Welverdiend Accommodation are available`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>We've checked and your dates are available: <b>${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b> at ${unitName}.</p>
      <p><b>Total due: ${rand(booking.totalAmount)}</b></p>
      <p>Please pay by EFT to:<br>${bankDetails}</p>
      ${uploadUrl
        ? `<p>Once you've paid, upload your proof of payment here to secure your booking:<br><a href="${uploadUrl}">${uploadUrl}</a></p>`
        : `<p>Please reply to this email with your proof of payment to secure your booking.</p>`}
      <p>We'll send a final confirmation as soon as we've checked it.</p>
    `
  });
}

async function notifyOwnerProofUploaded(booking, unitName) {
  await sendMail({
    to: ownerNotificationEmail,
    subject: `Proof of payment uploaded — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>${booking.guestName} has uploaded proof of payment for ${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}.</p>
      <p>Open your admin dashboard to check it and give final confirmation.</p>
    `
  });
}

async function notifyGuestConfirmed(booking, unitName) {
  await sendMail({
    to: booking.email,
    subject: `Confirmed — your stay at Welverdiend Accommodation`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>Your booking is confirmed: <b>${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b>.</p>
      <p>We look forward to hosting you. If you have any questions before your stay, just reply to this email.</p>
    `
  });
}

async function notifyGuestDeclined(booking, unitName, reason) {
  await sendMail({
    to: booking.email,
    subject: `Update on your Welverdiend Accommodation booking request`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>Unfortunately we're not able to confirm ${unitName} for ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}${reason ? `: ${reason}` : "."}</p>
      <p>Please feel free to try different dates — we'd love to host you another time.</p>
    `
  });
}

module.exports = {
  notifyOwnerNewRequest,
  notifyGuestApproved,
  notifyOwnerProofUploaded,
  notifyGuestConfirmed,
  notifyGuestDeclined
};
