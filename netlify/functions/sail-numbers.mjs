import { getStore } from "@netlify/blobs";
import { readFile } from "fs/promises";
import { resolve } from "path";

async function loadRegistry() {
  const store = getStore("sail-numbers");
  try {
    const blob = await store.get("registry", { type: "json" });
    if (blob) return blob;
  } catch {}
  const filePath = resolve("data/sail-numbers.json");
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function saveRegistry(registry) {
  const store = getStore("sail-numbers");
  registry.lastUpdated = new Date().toISOString();
  await store.set("registry", JSON.stringify(registry));
}

async function getActiveMember(email) {
  if (!email) return null;
  try {
    const members = getStore("members");
    const member = await members.get(email.toLowerCase(), { type: "json" });
    if (member && member.tier === "aktiv" && member.activatedAt) {
      return member;
    }
  } catch {}
  return null;
}

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    // GET — list numbers (kan også sjekke medlemsstatus med ?checkMember=email)
    if (req.method === "GET") {
      const registry = await loadRegistry();
      const status = url.searchParams.get("status");
      const checkMember = url.searchParams.get("checkMember");
      let numbers = registry.numbers;
      if (status) numbers = numbers.filter(n => n.status === status);

      const response = { lastUpdated: registry.lastUpdated, count: numbers.length, numbers };

      if (checkMember) {
        const member = await getActiveMember(checkMember);
        response.member = member ? {
          email: member.email, tier: member.tier,
          hasNumber: !!member.numberReserved,
          numberReserved: member.numberReserved || null,
        } : null;
      }
      return Response.json(response);
    }

    // POST — reserve a number
    if (req.method === "POST") {
      const body = await req.json();
      const { number, buyerName, buyerEmail, buyerPhone } = body;

      if (!number || !buyerName || !buyerEmail) {
        return Response.json(
          { error: "Missing required fields: number, buyerName, buyerEmail" },
          { status: 400 }
        );
      }

      const registry = await loadRegistry();
      let entry = registry.numbers.find(n => n.number === Number(number));

      // Hvis nummeret ikke finnes i registeret, opprett det som "available"
      // — vi viser kun 0-502 + spesialnumre, men medlemmer kan velge høyere
      // nummer ved direkte forespørsel (jf. NBK-praksis).
      if (!entry) {
        const n = Number(number);
        if (!Number.isInteger(n) || n < 0 || n > 99999) {
          return Response.json({ error: `Ugyldig nummer ${number} (må være heltall 0–99999)` }, { status: 400 });
        }
        entry = { number: n, status: "available" };
        registry.numbers.push(entry);
        // Sorter for ryddig listing
        registry.numbers.sort((a, b) => a.number - b.number);
        console.log(`NOR ${n} opprettet on-demand for reservasjon`);
      }

      if (entry.status !== "available") {
        return Response.json(
          { error: `NOR ${number} er ikke ledig (status: ${entry.status})` },
          { status: 409 }
        );
      }

      // Sjekk om bruker er aktivt medlem
      const member = await getActiveMember(buyerEmail);

      // Medlem som allerede har reservert et nummer — ikke tillat to
      if (member && member.numberReserved && member.numberReserved !== Number(number)) {
        return Response.json({
          error: `Du har allerede reservert NOR ${member.numberReserved}. Aktiv medlemskap inkluderer ett nummer.`,
        }, { status: 409 });
      }

      // ─── A) MEDLEM: gratis reservasjon ───
      if (member) {
        entry.status = "taken";
        entry.owner = buyerName;
        entry.purchasedAt = new Date().toISOString();
        entry.purchaseReference = `member-${member.email}-${Date.now()}`;
        entry.memberEmail = member.email;
        await saveRegistry(registry);

        // Oppdater medlems-blob
        const members = getStore("members");
        member.numberReserved = Number(number);
        member.numberReservedAt = new Date().toISOString();
        await members.set(buyerEmail.toLowerCase(), JSON.stringify(member));

        return Response.json({
          success: true,
          asMember: true,
          number: Number(number),
          message: `NOR ${number} reservert gratis som del av Aktiv medlemskap.`,
        });
      }

      // ─── B) IKKE MEDLEM: redirect til medlemskap-flyt (de må bli medlem først) ───
      return Response.json({
        success: false,
        requiresMembership: true,
        number: Number(number),
        membershipUrl: `/medlemskap/?reserveNumber=${number}`,
        message: `For å reservere NOR ${number} må du være Aktiv medlem (350 kr/år). Klikk for å bli medlem.`,
      }, { status: 402 }); // 402 Payment Required
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (err) {
    console.error("sail-numbers error:", err);
    return Response.json({ error: "Internal server error", details: err.message }, { status: 500 });
  }
};
