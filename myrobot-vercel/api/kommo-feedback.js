// api/kommo-feedback.js
// Recebe o formulário de feedback dos matriculados e grava DIRETO no CRM Kommo.
// Agora preenche CAMPOS PRÓPRIOS do contato (além de registrar a nota na timeline):
//   • E-mail
//   • NPS (numérico)
//   • Classificação NPS (Promotor / Neutro / Detrator)
//   • Depoimento
//   • Autoriza uso do depoimento (sim/não)
// + atualiza o Bairro do lead (se vier lead_id no link)
//
// Os campos são localizados pelo NOME automaticamente (criados pelo
// create-campos-feedback.js), então não há IDs fixos aqui.

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const FIELD_BAIRRO = 3880749; // campo "Bairro" do lead (mesmo do kommo-lead.js)

const digits = (s) => String(s || "").replace(/\D/g, "");
const classificarNPS = (n) => (n == null ? null : n >= 9 ? "Promotor" : n >= 7 ? "Neutro" : "Detrator");

// Gera variações do telefone p/ buscar no Kommo (BR salva ora COM, ora SEM o 9).
// Ex.: 5592991251655 (com 9) e 559291251655 (sem 9), além do número "cru".
function variacoesTelefone(tel) {
  const d = digits(tel);
  const set = new Set();
  if (!d) return [];
  set.add(d);
  // normaliza p/ ter 55 na frente
  const com55 = d.startsWith("55") ? d : "55" + d;
  set.add(com55);
  const resto = com55.slice(2); // DDD + número, sem o 55
  if (resto.length === 11 && resto[2] === "9") {
    // tem o 9 -> cria versão SEM o 9
    const sem9 = resto.slice(0, 2) + resto.slice(3);
    set.add("55" + sem9);
    set.add(sem9);
  } else if (resto.length === 10) {
    // não tem o 9 -> cria versão COM o 9
    const com9 = resto.slice(0, 2) + "9" + resto.slice(2);
    set.add("55" + com9);
    set.add(com9);
  }
  // também a versão sem 55 do número cru
  set.add(resto);
  return [...set].filter(Boolean);
}

async function acharContatoPorTelefone(api, auth, tel) {
  for (const q of variacoesTelefone(tel)) {
    const r = await fetch(`${api}/contacts?query=${encodeURIComponent(q)}`, { headers: auth });
    if (!r.ok) continue;
    const data = await r.json().catch(() => ({}));
    const c = (data?._embedded?.contacts || [])[0];
    if (c) return c;
  }
  return null;
}

// cache dos campos personalizados (resolvidos pelo nome)
let CAMPOS = null;
async function resolverCampos(api, auth) {
  if (CAMPOS) return CAMPOS;
  const map = {};
  let page = 1;
  while (page <= 20) {
    const r = await fetch(`${api}/contacts/custom_fields?limit=250&page=${page}`, { headers: auth });
    if (r.status === 204 || !r.ok) break;
    const d = await r.json().catch(() => ({}));
    const cfs = d?._embedded?.custom_fields || [];
    if (!cfs.length) break;
    for (const f of cfs) map[f.name] = f;
    if (!d?._links?.next) break;
    page++;
  }
  const sel = map["Classificação NPS"];
  const enums = {};
  if (sel?.enums) for (const e of sel.enums) enums[e.value] = e.id;
  CAMPOS = {
    nps: map["NPS"]?.id || null,
    classif: sel?.id || null,
    classifEnums: enums,
    depo: map["Depoimento"]?.id || null,
    autoriza: map["Autoriza uso do depoimento"]?.id || null,
  };
  return CAMPOS;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não configurado" });

  const b = req.body || {};
  const telefone = digits(b.telefone);
  const leadId = digits(b.lead_id);
  const email = String(b.email || "").trim();
  const bairro = String(b.bairro || "").trim();
  const nps = (b.nps === 0 || b.nps) ? Number(b.nps) : null;
  const comentario = String(b.comentario || "").trim();

  if (!telefone && !leadId) return res.status(400).json({ ok: false, motivo: "sem telefone nem lead_id" });

  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = `https://${SUBDOMAIN}.kommo.com/api/v4`;

  try {
    let contactId = null;
    let noteAlvo = null;

    if (leadId) {
      const r = await fetch(`${api}/leads/${leadId}?with=contacts`, { headers: auth });
      if (r.ok) {
        const lead = await r.json().catch(() => ({}));
        const c = lead?._embedded?.contacts?.find((x) => x.is_main) || lead?._embedded?.contacts?.[0];
        if (c) contactId = c.id;
        noteAlvo = { tipo: "leads", id: leadId };
      }
    }
    if (!contactId && telefone) {
      const c = await acharContatoPorTelefone(api, auth, telefone);
      if (c) { contactId = c.id; if (!noteAlvo) noteAlvo = { tipo: "contacts", id: c.id }; }
    }

    const feito = { contato_encontrado: !!contactId, campos: false, bairro: false, nota: false };

    // 1) Preenche os campos do contato (e-mail + NPS + classificação + depoimento + autoriza)
    if (contactId) {
      const campos = await resolverCampos(api, auth);
      const cfv = [];
      if (email) cfv.push({ field_code: "EMAIL", values: [{ value: email, enum_code: "WORK" }] });
      if (campos.nps && nps != null) cfv.push({ field_id: campos.nps, values: [{ value: nps }] });
      if (campos.depo && comentario) cfv.push({ field_id: campos.depo, values: [{ value: comentario }] });
      if (campos.autoriza) cfv.push({ field_id: campos.autoriza, values: [{ value: !!b.permite_uso }] });
      const classe = classificarNPS(nps);
      if (campos.classif && classe && campos.classifEnums[classe]) {
        cfv.push({ field_id: campos.classif, values: [{ enum_id: campos.classifEnums[classe] }] });
      }
      if (cfv.length) {
        const pr = await fetch(`${api}/contacts/${contactId}`, {
          method: "PATCH", headers: auth, body: JSON.stringify({ custom_fields_values: cfv }),
        });
        feito.campos = pr.ok;
      }
    }

    // 2) Bairro do lead (se houver lead_id)
    if (leadId && bairro) {
      const pr = await fetch(`${api}/leads/${leadId}`, {
        method: "PATCH", headers: auth,
        body: JSON.stringify({ custom_fields_values: [{ field_id: FIELD_BAIRRO, values: [{ value: bairro }] }] }),
      });
      feito.bairro = pr.ok;
    }

    // 3) Nota legível na timeline
    const alvo = noteAlvo || (contactId ? { tipo: "contacts", id: contactId } : null);
    if (alvo) {
      const titulo = b.origem_feedback
        ? `FEEDBACK (${b.origem_feedback})`
        : "FEEDBACK (formulário de matriculados)";
      const texto =
        titulo + "\n" +
        `Responsável: ${b.responsavel || "-"}\n` +
        `Aluno: ${b.aluno || "-"}\n` +
        `NPS: ${nps == null ? "-" : nps}/10 (${classificarNPS(nps) || "-"})\n` +
        `Bairro: ${bairro || "-"}\n` +
        `E-mail: ${email || "-"}\n` +
        `Autoriza uso do comentário: ${b.permite_uso ? "Sim" : "Não"}\n\n` +
        `Comentário: "${comentario || "-"}"`;
      const nr = await fetch(`${api}/${alvo.tipo}/${alvo.id}/notes`, {
        method: "POST", headers: auth,
        body: JSON.stringify([{ note_type: "common", params: { text: texto } }]),
      });
      feito.nota = nr.ok;
    }

    return res.status(200).json({ ok: true, feito });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
