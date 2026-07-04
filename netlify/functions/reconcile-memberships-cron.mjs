// Selvhelbredende sikkerhetsnett for medlemskap: kjører det eksisterende
// POST /api/admin/reconcile-memberships-endepunktet (PR #45) automatisk hver
// time — samme rolle som reconcile-legendekopp har for koppene.
//
// Bakgrunn: agreement-activated-webhooken fra Vipps fullfører ikke alltid
// koblingen mellom betalt avtale og seilnummer, og da blir nummer stående i
// "pending-membership" til noen kjører reconcile manuelt (skjedde 29.6.2026
// med NOR 110/111 — hang i 5 dager). Denne funksjonen fjerner det manuelle
// leddet.
//
// Designvalg: kaller endepunktet over HTTP i stedet for å duplisere logikken.
// All reconcile-logikk bor dermed fortsatt ETT sted (admin.mjs), og denne
// fila trenger aldri endres når logikken justeres. Endepunktet er idempotent
// og skriver aldri uten en matchende ACTIVE Vipps-avtale — trygt å kjøre
// hver time.
export default async () => {
  const siteUrl = process.env.SITE_URL || process.env.URL || "https://nbk.no";
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error("reconcile-memberships-cron: ADMIN_TOKEN mangler i env — hopper over");
    return new Response("ADMIN_TOKEN mangler", { status: 500 });
  }

  const res = await fetch(`${siteUrl}/api/admin/reconcile-memberships`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${adminToken}` },
  });
  const report = await res.json().catch(() => null);

  if (!res.ok) {
    console.error("reconcile-memberships-cron: endepunktet svarte", res.status, JSON.stringify(report));
    return Response.json({ ok: false, status: res.status, report }, { status: 502 });
  }

  const done = report?.completed?.length || 0;
  const skipped = report?.skipped?.length || 0;
  if (done > 0) {
    console.log(`reconcile-memberships-cron: fullførte ${done} strandede medlemskap:`, JSON.stringify(report.completed));
  } else {
    console.log(`reconcile-memberships-cron: ingenting å rydde (${skipped} hoppet over)`);
  }
  return Response.json({ ok: true, ...report });
};

// Hver time, 30 min forskjøvet fra reconcile-legendekopp (0 * * * *) så de
// ikke leser/skriver mot de samme blobs samtidig.
export const config = { schedule: "30 * * * *" };
