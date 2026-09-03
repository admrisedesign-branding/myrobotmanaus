// api/meta-capi.js — Kommo → Meta Conversions API (CAPI)
//
// Manda de volta pra Meta o que acontece DEPOIS do clique: aula agendada e matrícula.
// Assim as campanhas passam a otimizar por matrícula, não por formulário.
//
// Como ligar no Kommo (Automatize → coluna → "Enviar um webhook", quando movido para a etapa):
//   Aula Agendada              → https://www.myrobotmanaus.com/api/meta-capi?event=schedule
//   Aluno Ativo (matriculado)  → https://www.myrobotmanaus.com/api/meta-capi?event=purchase
//   (opcional) Qualificado     → https://www.myrobotmanaus.com/api/meta-capi?event=lead
//
// Teste manual (GET): /api/meta-capi?event=schedule&lead_id=63219863&test_event_code=TESTXXXX
//   (o test_event_code aparece em Gerenciador de Eventos → Testar eventos)
//
// Variáveis de ambiente na Vercel:
//   KOMMO_TOKEN      — já existe
//   META_PIXEL_ID    — 1365485995485803 (o mesmo Pixel do site)
//   META_CAPI_TOKEN  — gerado em Gerenciador de Eventos → Pixel → Configurações → API de Conversões
//                      → "Gerar token de acesso"

const crypto = require("crypto");

const SUBDOMAIN = "roboticanorte";
const KOMMO = `https://${SUBDOMAIN}.kommo.com/api/v4`;
const PIXEL_ID = process.env.META_PIXEL_ID || "1365485995485803";
const GRAPH = "https://graph.facebook.com/v21.0";

// campos do lead na Kommo
const F = { fbclid: 486041, utm_source: 486029, utm_campaign: 486027, filho: 3880753 };

// evento do funil → evento padrão da Meta
const EVENTS = {
  lead:     { name: "Lead",     valueFrom: null },
  schedule: { name: "Schedule", valueFrom: null },
  purchase: { name: "Purchase", valueFrom: "price" }, // valor da venda do lead
};

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const digits = (s) => String(s || "").replace(/\D/g, "");
const normName = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function e164(d) {
  d = digits(d);
  if (!d) return "";
  if (!d.startsWith("55")) d = "55" + d;
  return d; // Meta quer só dígitos com DDI, sem "+"
}
function cf(lead, id) {
  const f = (lead.custom_fields_values || []).find((x) => x.field_id === id);
  return f?.values?.[0]?.value || "";
}
async function kommo(path) {
  const r = await fetch(KOMMO + path, { headers: { Authorization: `Bearer ${process.env.KOMMO_TOKEN}` } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Kommo ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
function leadIdsFromWebhook(body) {
  // Kommo manda form-urlencoded: leads[status][0][id]=123  (ou leads[add][0][id])
  const ids = new Set();
  for (const k of Object.keys(body || {})) {
    const m = k.match(/^leads\[(?:status|add|update)\]\[\d+\]\[id\]$/);
    if (m) ids.add(String(body[k]));
  }
  return [...ids];
}

async function buildEvent(leadId, kind, ip, ua) {
  const ev = EVENTS[kind];
  const lead = await kommo(`/leads/${leadId}?with=contacts`);
  if (!lead) throw new Error("lead não encontrado");
  const contactId = lead._embedded?.contacts?.[0]?.id;
  const contact = contactId ? await kommo(`/contacts/${contactId}`) : null;

  const phones = [], emails = [];
  for (const f of contact?.custom_fields_values || []) {
    if (f.field_code === "PHONE") for (const v of f.values || []) phones.push(e164(v.value));
    if (f.field_code === "EMAIL") for (const v of f.values || []) emails.push(String(v.value || "").toLowerCase().trim());
  }
  const [first, ...rest] = normName(contact?.name).split(/\s+/);

  const user_data = {
    external_id: [sha(String(leadId))],
    ...(phones.length && { ph: phones.filter(Boolean).map(sha) }),
    ...(emails.length && { em: emails.filter(Boolean).map(sha) }),
    ...(first && { fn: [sha(first)] }),
    ...(rest.length && { ln: [sha(rest.join(" "))] }),
    ...(ip && { client_ip_address: ip }),
    ...(ua && { client_user_agent: ua }),
  };
  // fbc = "fb.1.<timestamp>.<fbclid>" — é o que amarra o evento ao clique no anúncio
  const fbclid = cf(lead, F.fbclid);
  if (fbclid) user_data.fbc = `fb.1.${(lead.created_at || Math.floor(Date.now() / 1000)) * 1000}.${fbclid}`;

  const custom_data = {
    currency: "BRL",
    lead_id: String(leadId),
    utm_source: cf(lead, F.utm_source) || undefined,
    utm_campaign: cf(lead, F.utm_campaign) || undefined,
    content_name: cf(lead, F.filho) || undefined,
  };
  if (ev.valueFrom === "price") custom_data.value = Number(lead.price || 0);

  return {
    event_name: ev.name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: `${kind}-${leadId}`, // dedup: reenvio do mesmo lead não conta duas vezes
    action_source: "system_generated", // evento vindo do CRM
    user_data,
    custom_data,
  };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const kind = String(q.event || "").toLowerCase();
  if (!EVENTS[kind]) return res.status(400).json({ ok: false, error: "event deve ser lead | schedule | purchase" });
  if (!process.env.META_CAPI_TOKEN) return res.status(500).json({ ok: false, error: "META_CAPI_TOKEN não configurado" });

  // ids: manual (?lead_id=) ou webhook da Kommo (body form-urlencoded)
  let ids = q.lead_id ? [String(q.lead_id)] : leadIdsFromWebhook(req.body);
  if (!ids.length) return res.status(200).json({ ok: true, sent: 0, reason: "sem lead_id" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || undefined;
  const results = [];
  for (const id of ids) {
    try {
      const data = await buildEvent(id, kind, undefined, undefined);
      const payload = { data: [data] };
      if (q.test_event_code) payload.test_event_code = String(q.test_event_code);
      const r = await fetch(`${GRAPH}/${PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      results.push({ lead_id: id, event: data.event_name, ok: r.ok, meta: j, matched: { ph: !!data.user_data.ph, fbc: !!data.user_data.fbc } });
    } catch (e) {
      results.push({ lead_id: id, ok: false, error: e.message });
    }
  }
  return res.status(200).json({ ok: results.every((r) => r.ok), sent: results.filter((r) => r.ok).length, results });
};
