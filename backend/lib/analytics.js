const { pageviewsCollection } = require("./db");

/**
 * Classifies a referrer URL into a readable traffic source. No cookies,
 * no third-party scripts — just categorizes wherever the browser says
 * the visitor came from.
 */
function classifySource(referrer) {
  if (!referrer) return "Direct";
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host.includes("facebook.com") || host.includes("fb.com") || host.includes("l.facebook")) return "Facebook";
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("whatsapp.com") || host.includes("wa.me")) return "WhatsApp";
    if (host.includes("google.")) return "Google";
    if (host.includes("welverdiendaccommodation.com") || host.includes("run.app")) return "Internal (within the site)";
    return host;
  } catch (e) {
    return "Other";
  }
}

async function recordPageview({ page, referrer }) {
  const now = new Date();
  await pageviewsCollection.add({
    page: (page || "/").slice(0, 100),
    source: classifySource(referrer),
    date: now.toISOString().slice(0, 10),
    createdAt: now.toISOString()
  });
}

async function getAnalyticsSummary(days) {
  days = days || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const snap = await pageviewsCollection.where("date", ">=", cutoffStr).get();
  const views = snap.docs.map(d => d.data());

  const byPage = {}, bySource = {}, byDay = {};
  views.forEach(v => {
    byPage[v.page] = (byPage[v.page] || 0) + 1;
    bySource[v.source] = (bySource[v.source] || 0) + 1;
    byDay[v.date] = (byDay[v.date] || 0) + 1;
  });

  const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  return {
    totalViews: views.length,
    days,
    byPage: sortDesc(byPage).map(([page, count]) => ({ page, count })),
    bySource: sortDesc(bySource).map(([source, count]) => ({ source, count })),
    byDay: Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }))
  };
}

module.exports = { recordPageview, getAnalyticsSummary };
