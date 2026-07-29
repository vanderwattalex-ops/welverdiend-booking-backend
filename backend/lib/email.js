const nodemailer = require("nodemailer");
const { getSettings } = require("./settings");

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

async function sendMail({ to, subject, html, attachments }) {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] EMAIL_USER / EMAIL_APP_PASSWORD not set — skipping email:", subject, "to:", to);
    return { sent: false, reason: "Email is not configured (EMAIL_USER / EMAIL_APP_PASSWORD missing)." };
  }
  if (!to) {
    console.warn("[email] No recipient address for:", subject);
    return { sent: false, reason: "No recipient address was set." };
  }
  try {
    await t.sendMail({ from: `Welverdiend Accommodation <${process.env.EMAIL_USER}>`, to, subject, html, attachments });
    console.log("[email] sent:", subject, "to:", to);
    return { sent: true };
  } catch (err) {
    // A failed email should never break the booking flow itself.
    console.error("[email] failed to send:", subject, "to:", to, "-", err.message);
    return { sent: false, reason: err.message };
  }
}

function fmtDate(d) { return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }); }
function rand(n) { return `R${Number(n || 0).toFixed(2)}`; }

async function notifyOwnerNewRequest(booking, unitName) {
  const { ownerNotificationEmail } = await getSettings();
  return sendMail({
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
        <li><b>Total:</b> ${rand(booking.totalAmount)} (${rand(booking.depositAmount)} deposit + ${rand(booking.balanceAmount)} balance)</li>
      </ul>
      <p>Open your admin dashboard to approve or decline these dates.</p>
    `
  });
}

async function notifyGuestApproved(booking, unitName) {
  const { bankDetails, frontendBaseUrl } = await getSettings();
  const uploadUrl = frontendBaseUrl
    ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}`
    : null;
  return sendMail({
    to: booking.email,
    subject: `Good news — your dates at Welverdiend Accommodation are available`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>We've checked and your dates are available: <b>${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b> at ${unitName}.</p>
      <p>A <b>50% deposit of ${rand(booking.depositAmount)}</b> secures your booking (the remaining ${rand(booking.balanceAmount)} balance is due before check-in).</p>
      <p>Please pay the deposit by EFT to:<br>${bankDetails}</p>
      ${uploadUrl
        ? `<p>Once you've paid, upload your proof of payment here to secure your booking:<br><a href="${uploadUrl}">${uploadUrl}</a></p>`
        : `<p>Please reply to this email with your proof of payment to secure your booking.</p>`}
      <p>We'll send a final confirmation as soon as we've checked it.</p>
    `
  });
}

async function notifyOwnerProofUploaded(booking, unitName) {
  const { ownerNotificationEmail } = await getSettings();
  return sendMail({
    to: ownerNotificationEmail,
    subject: `Deposit proof uploaded — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>${booking.guestName} has uploaded deposit proof of payment (${rand(booking.depositAmount)}) for ${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}.</p>
      <p>Open your admin dashboard to check it and give final confirmation.</p>
    `
  });
}

async function notifyGuestConfirmed(booking, unitName, invoiceBuffer) {
  return sendMail({
    to: booking.email,
    subject: `Confirmed — your stay at Welverdiend Accommodation`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>Your booking is confirmed: <b>${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b>.</p>
      <p>Your deposit has been received. The remaining balance of <b>${rand(booking.balanceAmount)}</b> is due before check-in — we'll be in touch closer to your stay with a link to pay it.</p>
      <p>Your invoice is attached for your records.</p>
      <p>We look forward to hosting you. If you have any questions before your stay, just reply to this email.</p>
    `,
    attachments: invoiceBuffer ? [{ filename: `invoice-${booking.id.slice(0, 8)}.pdf`, content: invoiceBuffer }] : undefined
  });
}

async function notifyGuestDeclined(booking, unitName, reason) {
  return sendMail({
    to: booking.email,
    subject: `Update on your Welverdiend Accommodation booking request`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>Unfortunately we're not able to confirm ${unitName} for ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}${reason ? `: ${reason}` : "."}</p>
      <p>Please feel free to try different dates — we'd love to host you another time.</p>
    `
  });
}

async function notifyGuestBalanceDue(booking, unitName) {
  const { frontendBaseUrl } = await getSettings();
  const uploadUrl = frontendBaseUrl
    ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}`
    : null;
  return sendMail({
    to: booking.email,
    subject: `Final payment due — your stay at Welverdiend Accommodation`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>Your stay at ${unitName} (${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}) is coming up — the remaining balance of <b>${rand(booking.balanceAmount)}</b> is now due.</p>
      ${uploadUrl
        ? `<p>Please pay by EFT and upload your proof of payment here:<br><a href="${uploadUrl}">${uploadUrl}</a></p>`
        : `<p>Please reply to this email once you've paid the balance.</p>`}
      <p>We look forward to hosting you.</p>
    `
  });
}

async function notifyGuestCheckinReminder(booking, unitName) {
  const { frontendBaseUrl } = await getSettings();
  const uploadUrl = frontendBaseUrl ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}` : null;
  const paidSoFar = booking.balanceStatus === "paid" ? booking.totalAmount : booking.depositAmount;
  const balanceLine = booking.balanceStatus === "paid"
    ? `<p>You're paid in full — nothing further owed.</p>`
    : `<p>Your remaining balance of <b>${rand(booking.balanceAmount)}</b> is still due. ${uploadUrl ? `Please pay by EFT and upload proof here: <a href="${uploadUrl}">${uploadUrl}</a>` : "Please arrange payment before check-in."}</p>`;

  return sendMail({
    to: booking.email,
    subject: `Your stay is coming up — check-in in 2 days`,
    html: `
      <p>Hi ${booking.guestName},</p>
      <p>Just a reminder that your stay at <b>${unitName}</b> starts on <b>${fmtDate(booking.checkIn)}</b> (check-out ${fmtDate(booking.checkOut)}).</p>
      <p>Amount paid so far: <b>${rand(paidSoFar)}</b> of ${rand(booking.totalAmount)} total.</p>
      ${balanceLine}
      <p>We look forward to hosting you!</p>
    `
  });
}

async function notifyOwnerBalanceProofUploaded(booking, unitName) {
  const { ownerNotificationEmail } = await getSettings();
  return sendMail({
    to: ownerNotificationEmail,
    subject: `Final payment proof uploaded — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>${booking.guestName} has uploaded proof of the final balance payment (${rand(booking.balanceAmount)}) for ${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}.</p>
      <p>Open your admin dashboard to check it and mark the balance as received.</p>
    `
  });
}

async function sendTestEmail(to) {
  return sendMail({
    to,
    subject: "Test email from your Welverdiend Accommodation booking system",
    html: `<p>This is a test email — if you're reading this, notification emails are working correctly.</p>`
  });
}

module.exports = {
  notifyOwnerNewRequest,
  notifyGuestApproved,
  notifyOwnerProofUploaded,
  notifyGuestConfirmed,
  notifyGuestDeclined,
  notifyGuestBalanceDue,
  notifyGuestCheckinReminder,
  notifyOwnerBalanceProofUploaded,
  sendTestEmail
};
