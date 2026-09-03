// api/kommo-dedupe.js
// Chamado pelo Salesbot QUALIFICA no INÍCIO do fluxo (lead que entra pelo WhatsApp).
//
// O que faz: pega o telefone desse lead e procura se a MESMA pessoa já tem um lead do SITE
// (tag "site"). Se tiver (é duplicado):
//   • SURVIVOR = "whatsapp": o lead do WhatsApp SOBREVIVE (ele carrega o chat no card).
//       - copia pro lead do WhatsApp os campos de qualificação do lead do site
//       - adiciona a tag "site" ao lead do WhatsApp
//       - marca o campo "Dedupe" = sim  → SINAL que o bot lê pra pular as perguntas
//       - FECHA o lead do site como duplicado (Perdido / 143)
//     Assim o comercial abre 1 card só, em Novo Lead, COM a conversa do WhatsApp dentro.
// Se não achar nada, não faz nada (o bot segue a qualificação normal).
//
// Config: variável de ambiente KOMMO_TOKEN na Vercel (a mesma que já existe).
// ─────────────────────────────────────────────────────────────────────────────
const SUBDOMAIN = "roboticanorte";
const API = `https://${SUBDOMAIN}.kommo.com/api/v4`;

// Quem sobrevive quando é duplicado. "whatsapp" = mantém o lead do WhatsApp (com o chat),
// fecha o do site. "site" = o contrário. Aqui usamos "whatsapp".
const SURVIVOR = "whatsapp";

const SITE_TAG = "site";
const BOT_TAG = "whatsapp-bot";
const DUP_TAG = "ja-cadastrado"; // tag pra filtro visual

// Sinal que o Salesbot lê por CONDIÇÃO (a conta não deixa condicionar por tag,
// nem digitar valor — só checar "preenchido / não preenchido").
// Gravamos no campo dedicado "Dedupe" (id 3883241) do lead que SOBREVIVE.
const FIELD_DEDUPE = 3883241;
const DUP_SIGNAL = "sim";

// Campos de qualificação a copiar do lead do site -> lead do WhatsApp.
// (Score, Categoria, Área, Trilha, Momento, Bairro, Origem, Filho)
const COPY_FIELDS = [3880739, 3880741, 3880743, 3880745, 3880747, 3880749, 3880751, 3880753];

const CLOSED_STATUSES = [142, 143]; // ganho / perdido

// ─── helpers ─────────────────────────────────────────────────────────────────
function digits(s) { return String(s || "").replace(/\D/g, ""); }

// ─── telefone: variante do 9º dígito (Manaus) ───────────────────────────────
// O WhatsApp entrega números antigos de Manaus SEM o 9 (55 92 8245-1514, 12 dígitos);
// o formulário do site grava COM o 9 (55 92 9 8245-1514, 13 dígitos). Pra casar os
// dois, comparamos pela "chave": DDD + últimos 8 dígitos.
function phoneKey(d) {
  d = digits(d);
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length < 10) return d;
  return d.slice(0, 2) + d.slice(-8); // DDD + 8 finais
}
function phoneVariants(d) {
  d = digits(d);
  const nat = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  const ddd = nat.slice(0, 2), rest = nat.slice(2);
  const out = new Set();
  if (rest.length === 8) { out.add(ddd + rest); out.add(ddd + "9" + rest); }
  else if (rest.length === 9 && rest[0] === "9") { out.add(ddd + rest); out.add(ddd + rest.slice(1)); }
  else out.add(nat);
  return [...out];
}
function contactMatchesPhone(contact, phoneDig) {
  const key = phoneKey(phoneDig);
  const cfs = contact.custom_fields_values || [];
  for (const f of cfs) {
    if (!(f.field_code === "PHONE" || /phone|telefone/i.test(f.field_name || ""))) continue;
    for (const v of f.values || []) if (phoneKey(v.value) === key) return true;
  }
  return false;
}

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
// que NÃO seja o próprio lead atual. Retorna o lead completo (com campos e tags).
async function findSiteLead(token, phoneDig, currentLeadId) {
  if (!phoneDig) return null;
  // busca pelas duas grafias (com e sem o 9) e junta os contatos encontrados
  const found = new Map();
  for (const q of phoneVariants(phoneDig)) {
    const { ok, data } = await kommo(
      token,
      `/contacts?query=${encodeURIComponent(q)}&with=leads&limit=20`
    );
    for (const c of (ok && data?._embedded?.contacts) || []) found.set(c.id, c);
  }
  // fallback: só os 8 finais (pega grafias com espaço/hífen que o query não casou)
  if (!found.size) {
    const tail = digits(phoneDig).slice(-8);
    const { ok, data } = await kommo(token, `/contacts?query=${tail}&with=leads&limit=50`);
    for (const c of (ok && data?._embedded?.contacts) || []) found.set(c.id, c);
  }
  const contacts = [...found.values()].filter((c) => contactMatchesPhone(c, phoneDig));
  if (!contacts.length) return null;

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

// monta os custom_fields_values a copiar do lead do site (só os que existem e têm valor)
function fieldsToCopy(siteLead) {
  const src = siteLead.custom_fields_values || [];
  const out = [];
  for (const f of src) {
    if (!COPY_FIELDS.includes(f.field_id)) continue;
    const values = (f.values || [])
      .map((v) => {
        if (v.enum_id != null) return { enum_id: v.enum_id };
        if (v.value != null && String(v.value).trim() !== "") return { value: v.value };
        return null;
      })
      .filter(Boolean);
    if (values.length) out.push({ field_id: f.field_id, values });
  }
  return out;
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

    // 3) É DUPLICADO → sobrevive o lead do WhatsApp (este), fecha o do site.
    const meTags = lead?._embedded?.tags || [];

    // 3a) copia a qualificação do site + tag "site" + sinal Dedupe pro lead do WhatsApp
    const copied = fieldsToCopy(siteLead);
    const dedupeField = { field_id: FIELD_DEDUPE, values: [{ value: DUP_SIGNAL }] };
    // não duplica o campo Dedupe se por acaso já veio na cópia
    const cfPayload = [...copied.filter((f) => f.field_id !== FIELD_DEDUPE), dedupeField];

    await kommo(token, `/leads/${currentId}`, {
      method: "PATCH",
      body: JSON.stringify({
        custom_fields_values: cfPayload,
        _embedded: { tags: mergeTags(meTags, [SITE_TAG, DUP_TAG]) },
      }),
    });

    // 3b) fecha o lead do site como duplicado (Perdido / 143) + tag de marcação
    await kommo(token, `/leads/${siteLead.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status_id: 143,
        _embedded: { tags: mergeTags(siteLead._embedded?.tags, [DUP_TAG]) },
      }),
    });

    return res.status(200).json({ ok: true, duplicate: true, survivor: currentId, closed: siteLead.id });
  } catch (err) {
    console.error("dedupe erro:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
