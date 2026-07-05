// api/kommo-dedupe.js
// Chamado pelo Salesbot QUALIFICA no INÍCIO do fluxo (quando um lead entra pelo WhatsApp).
//
// O que faz: pega o telefone desse lead e procura se a MESMA pessoa já tem um lead do SITE
// (tag "site"). Se tiver:
//   • adiciona a tag "whatsapp-bot" ao lead do SITE (mantém a ordem: site -> whatsapp-bot)
//   • adiciona a tag "ja-cadastrado" a ESTE lead do bot  → é o SINAL que o bot vai ler
// Se não achar nada, não faz nada (o bot segue a qualificação normal).
//
// O bot, depois de chamar este webhook, espera alguns segundos e verifica:
//   tem a tag "ja-cadastrado"?  SIM → manda a mensagem de handoff e move pra Perdido (143)
//                               NÃO → faz as 4 perguntas de sempre.
//
// Config: variável de ambiente KOMMO_TOKEN na Vercel (a mesma que já existe).
// ─────────────────────────────────────────────────────────────────────────────
const SUBDOMAIN = "roboticanorte";
const API = `https://${SUBDOMAIN}.kommo.com/api/v4`;

// Se um dia você quiser INVERTER (manter o lead do WhatsApp e fechar o do site),
// troque para "whatsapp". Por padrão o lead do SITE é o que sobrevive.
const SURVIVOR = "site";

// tag que marca a origem do site (a mesma que o kommo-lead.js usa)
const SITE_TAG = "site";
const BOT_TAG = "whatsapp-bot";
const DUP_TAG = "ja-cadastrado"; // sinal que o Salesbot vai checar

const CLOSED_STATUSES = [142, 143]; // ganho / perdido → considerados "fechados"

// ─── helpers ─────────────────────────────────────────────────────────────────
function digits(s) { return String(s || "").replace(/\D/g, ""); }

async function kommo(token, path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Extrai o ID do lead atual — aceita ?lead_id=... na URL OU o corpo que a Kommo manda.
function extractLeadId(req) {
  const q = req.query?.lead_id;
  if (q && !String(q).includes("{{")) {
    const n = digits(q);
    if (n) return Number(n);
  }
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const m = raw.match(/leads\[[^\]]*\]\[\d+\]\[id\]"?\s*[:=]\s*"?(\d+)/);
  if (m) return Number(m[1]);
  const m2 = raw.match(/"lead_id"\s*:\s*"?(\d+)/) || raw.match(/"id"\s*:\s*(\d+)/);
  if (m2) return Number(m2[1]);
  return null;
}

function mergeTags(existing, toAdd) {
  const names = (existing || []).map((t) => t.name);
  for (const name of toAdd) if (name && !names.includes(name)) names.push(name);
  return names.map((name) => ({ name }));
}

async function getLead(token, id) {
  const { ok, data } = await kommo(token, `/leads/${id}?with=contacts`);
  return ok ? data : null;
}

async function getContactPhone(token, contactId) {
  const { ok, data } = await kommo(token, `/contacts/${contactId}`);
  if (!ok) return "";
  const cfs = data.custom_fields_values || [];
  const phoneField = cfs.find(
    (f) => f.field_code === "PHONE" || /phone|telefone/i.test(f.field_name || "")
  );
  const val = phoneField?.values?.[0]?.value || "";
  return digits(val);
}

// procura, entre todos os contatos com esse telefone, um lead ABERTO com a tag "site"
// que NÃO seja o próprio lead atual.
async function findSiteLead(token, phoneDig, currentLeadId) {
  if (!phoneDig) return null;
  const { ok, data } = await kommo(
    token,
    `/contacts?query=${encodeURIComponent(phoneDig)}&with=leads&limit=10`
  );
  const contacts = data?._embedded?.contacts || [];
  if (!ok || !contacts.length) return null;

  const leadIds = [];
  for (const c of contacts) {
    for (const l of c._embedded?.leads || []) {
      if (l.id !== currentLeadId) leadIds.push(l.id);
    }
  }
  if (!leadIds.length) return null;

  const idParams = [...new Set(leadIds)].map((id) => `filter[id][]=${id}`).join("&");
  const res = await kommo(token, `/leads?${idParams}&limit=50`);
  const leads = res.data?._embedded?.leads || [];

  const candidates = leads
    .filter((l) => !CLOSED_STATUSES.includes(l.status_id))
    .filter((l) => (l._embedded?.tags || []).some((t) => t.name === SITE_TAG))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  return candidates[0] || null;
}

// ─── handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não configurado" });

  try {
    const currentId = extractLeadId(req);
    if (!currentId) return res.status(200).json({ ok: true, duplicate: false, reason: "sem lead_id" });

    // 1) telefone do lead atual (o do WhatsApp)
    const lead = await getLead(token, currentId);
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return res.status(200).json({ ok: true, duplicate: false, reason: "sem contato" });

    const phoneDig = await getContactPhone(token, contactId);
    if (!phoneDig) return res.status(200).json({ ok: true, duplicate: false, reason: "sem telefone" });

    // 2) já existe lead do site com esse telefone?
    const siteLead = await findSiteLead(token, phoneDig, currentId);
    if (!siteLead) return res.status(200).json({ ok: true, duplicate: false });

    // 3) é duplicado → decide quem sobrevive
    if (SURVIVOR === "site") {
      // sobrevive o lead do SITE: recebe a tag whatsapp-bot
      await kommo(token, `/leads/${siteLead.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          _embedded: { tags: mergeTags(siteLead._embedded?.tags, [BOT_TAG]) },
        }),
      });
      // este lead (do bot) é marcado como duplicado → sinal pro Salesbot
      const meTags = lead?._embedded?.tags || [];
      await kommo(token, `/leads/${currentId}`, {
        method: "PATCH",
        body: JSON.stringify({ _embedded: { tags: mergeTags(meTags, [DUP_TAG]) } }),
      });
      return res.status(200).json({ ok: true, duplicate: true, survivor: siteLead.id, closed: currentId });
    } else {
      // (opção invertida) sobrevive o lead do WhatsApp: recebe a tag "site"
      const meTags = lead?._embedded?.tags || [];
      await kommo(token, `/leads/${currentId}`, {
        method: "PATCH",
        body: JSON.stringify({ _embedded: { tags: mergeTags(meTags, [SITE_TAG]) } }),
      });
      // fecha o lead do site como duplicado
      await kommo(token, `/leads/${siteLead.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status_id: 143,
          _embedded: { tags: mergeTags(siteLead._embedded?.tags, [DUP_TAG]) },
        }),
      });
      // aqui NÃO marcamos "ja-cadastrado" no lead atual, porque ele deve seguir vivo.
      return res.status(200).json({ ok: true, duplicate: true, survivor: currentId, closed: siteLead.id });
    }
  } catch (err) {
    console.error("dedupe erro:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
