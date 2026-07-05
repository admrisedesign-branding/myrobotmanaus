// api/kommo-lead.js
// Cria OU atualiza o lead na Kommo a partir do formulário do site My Robot Manaus.
//
// NOVO: deduplicação. Antes de criar, procura o contato pelo telefone.
//   • Contato já existe e tem lead ABERTO  -> ATUALIZA esse lead (adiciona a tag "site",
//     preenche os campos que estiverem vazios). NÃO cria outro lead.
//   • Contato existe mas sem lead aberto    -> cria lead novo já ligado a esse contato.
//   • Contato não existe                    -> cria do zero (comportamento antigo).
//
// Configuração: só a variável de ambiente KOMMO_TOKEN na Vercel (igual antes).
// ─────────────────────────────────────────────────────────────────────────────
const SUBDOMAIN   = "roboticanorte";
const PIPELINE_ID = 13965588;   // My Robot — Comercial 2026
const STATUS_ID   = 107779724;  // Novo Lead

const FIELD = {
  score:     3880739,
  categoria: 3880741,
  area:      3880743,
  trilha:    3880745,
  momento:   3880747,
  bairro:    3880749,
  origem:    3880751,
  filho:     3880753,
};
const CATEGORIA_ENUM = { Quente: 4299211, Morno: 4299213, Frio: 4299215 };

// Status "fechados" padrão da Kommo (não reabrir esses): 142 = ganho, 143 = perdido.
const CLOSED_STATUSES = [142, 143];

const API = `https://${SUBDOMAIN}.kommo.com/api/v4`;

// ─── helpers ─────────────────────────────────────────────────────────────────
function digits(s) { return String(s || "").replace(/\D/g, ""); }

function normalizePhone(s) {
  let d = digits(s);
  if (d.length >= 10 && d.length <= 11) d = "55" + d; // BR local -> +55
  return d ? "+" + d : "";
}

function txt(id, value) {
  if (!id || value == null || String(value).trim() === "") return null;
  return { field_id: id, values: [{ value: String(value) }] };
}

function categoriaField(raw) {
  if (!raw) return null;
  const key = ["Quente", "Morno", "Frio"].find((k) =>
    String(raw).toLowerCase().includes(k.toLowerCase())
  );
  if (!key) return null;
  return { field_id: FIELD.categoria, values: [{ enum_id: CATEGORIA_ENUM[key] }] };
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

// Procura contato pelos dígitos do telefone. Retorna o contato (com leads) ou null.
async function findContactByPhone(token, phoneDig) {
  if (!phoneDig) return null;
  const q = encodeURIComponent(phoneDig);
  const { ok, data } = await kommo(token, `/contacts?query=${q}&with=leads&limit=10`);
  const contacts = data?._embedded?.contacts || [];
  if (!ok || !contacts.length) return null;

  // confirma que algum telefone do contato realmente contém esses dígitos
  // (evita falso-positivo de busca genérica)
  const match = contacts.find((c) => {
    const cfs = c.custom_fields_values || [];
    return cfs.some(
      (f) =>
        (f.field_code === "PHONE" || /phone/i.test(f.field_name || "")) &&
        (f.values || []).some((v) => digits(v.value).includes(phoneDig) || phoneDig.includes(digits(v.value)))
    );
  });
  return match || contacts[0];
}

// Dado um contato, devolve o lead aberto mais recente (ou null).
async function findOpenLead(token, contact) {
  const leadStubs = contact?._embedded?.leads || [];
  if (!leadStubs.length) return null;

  const idParams = leadStubs.map((l) => `filter[id][]=${l.id}`).join("&");
  const { ok, data } = await kommo(token, `/leads?${idParams}&limit=50`);
  const leads = data?._embedded?.leads || [];
  if (!ok || !leads.length) return null;

  const open = leads
    .filter((l) => !CLOSED_STATUSES.includes(l.status_id))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  return open[0] || null;
}

// Junta tags existentes + novas, sem duplicar (mantém a ORDEM de chegada).
function mergeTags(existing, toAdd) {
  const names = (existing || []).map((t) => t.name);
  for (const name of toAdd) {
    if (name && !names.includes(name)) names.push(name);
  }
  return names.map((name) => ({ name }));
}

// ─── handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não configurado na Vercel" });

  try {
    const b = req.body || {};
    const score = Number(b.score) || 0;
    const filho = [b.fn, b.fi ? b.fi + " anos" : ""].filter(Boolean).join(" — ");
    const cat =
      ["Quente", "Morno", "Frio"].find((k) =>
        String(b.categoria || "").toLowerCase().includes(k.toLowerCase())
      ) || "Frio";

    const leadFields = [
      txt(FIELD.score, score),
      categoriaField(b.categoria),
      txt(FIELD.area, b.area),
      txt(FIELD.trilha, b.trilha),
      txt(FIELD.momento, b.mom),
      txt(FIELD.bairro, b.bairro),
      txt(FIELD.origem, b.orig),
      txt(FIELD.filho, filho),
    ].filter(Boolean);

    const phonePlus = normalizePhone(b.wn); // +5592...
    const phoneDig = digits(phonePlus);     // 5592...

    // ── 1) EXISTE contato com esse telefone? ─────────────────────────────────
    const contact = phoneDig ? await findContactByPhone(token, phoneDig) : null;

    if (contact) {
      const openLead = await findOpenLead(token, contact);

      if (openLead) {
        // ── 1a) Já tem lead aberto -> ATUALIZA (não cria outro) ──────────────
        // pega o estado atual do lead pra mesclar tags e não sobrescrever campos preenchidos
        const { data: current } = await kommo(token, `/leads/${openLead.id}`);
        const existingTags = current?._embedded?.tags || openLead?._embedded?.tags || [];
        const existingCFs = current?.custom_fields_values || openLead?.custom_fields_values || [];
        const filledIds = new Set(existingCFs.map((f) => f.field_id));

        // só preenche campo que ainda está VAZIO no lead (preserva a qualificação do bot)
        const fieldsToFill = leadFields.filter((f) => !filledIds.has(f.field_id));

        // tags acumulam na ordem: o que já existe + "site" + categoria
        const tags = mergeTags(existingTags, ["site", cat]);

        const patch = { _embedded: { tags } };
        if (fieldsToFill.length) patch.custom_fields_values = fieldsToFill;

        const upd = await kommo(token, `/leads/${openLead.id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        if (!upd.ok) {
          console.error("Kommo PATCH erro:", upd.status, JSON.stringify(upd.data));
          return res.status(502).json({ error: "Kommo recusou update", status: upd.status, data: upd.data });
        }
        return res.status(200).json({ ok: true, action: "updated", lead_id: openLead.id, kommo: upd.data });
      }

      // ── 1b) Contato existe mas sem lead aberto -> cria lead ligado a ele ────
      const create = await kommo(token, `/leads`, {
        method: "POST",
        body: JSON.stringify([
          {
            name: `Site — ${b.fn || "filho(a)"} (${b.rn || "responsável"})`,
            pipeline_id: PIPELINE_ID,
            status_id: STATUS_ID,
            custom_fields_values: leadFields,
            _embedded: {
              contacts: [{ id: contact.id }],
              tags: [{ name: "site" }, { name: cat }],
            },
          },
        ]),
      });
      if (!create.ok) {
        console.error("Kommo POST /leads erro:", create.status, JSON.stringify(create.data));
        return res.status(502).json({ error: "Kommo recusou", status: create.status, data: create.data });
      }
      return res.status(200).json({ ok: true, action: "created-linked", kommo: create.data });
    }

    // ── 2) Contato NÃO existe -> cria do zero (complex) ──────────────────────
    const contactFields = [];
    if (phonePlus) contactFields.push({ field_code: "PHONE", values: [{ value: phonePlus, enum_code: "WORK" }] });
    if (b.em) contactFields.push({ field_code: "EMAIL", values: [{ value: b.em, enum_code: "WORK" }] });

    const complex = await kommo(token, `/leads/complex`, {
      method: "POST",
      body: JSON.stringify([
        {
          name: `Site — ${b.fn || "filho(a)"} (${b.rn || "responsável"})`,
          pipeline_id: PIPELINE_ID,
          status_id: STATUS_ID,
          custom_fields_values: leadFields,
          _embedded: {
            contacts: [{ name: b.rn || b.fn || "Lead do site", custom_fields_values: contactFields }],
            tags: [{ name: "site" }, { name: cat }],
          },
        },
      ]),
    });
    if (!complex.ok) {
      console.error("Kommo complex erro:", complex.status, JSON.stringify(complex.data));
      return res.status(502).json({ error: "Kommo recusou", status: complex.status, data: complex.data });
    }
    return res.status(200).json({ ok: true, action: "created-new", kommo: complex.data });
  } catch (err) {
    console.error("Falha geral:", err);
    return res.status(500).json({ error: String(err) });
  }
}
