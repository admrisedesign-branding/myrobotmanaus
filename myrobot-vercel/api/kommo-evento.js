// api/kommo-evento.js
// Recebe o formulário de captação de EVENTOS (tablet/celular dos consultores)
// e cria o lead direto no CRM Kommo, marcado como "Evento".
//
// Campos capturados no evento (enxuto, pra ser rápido no tablet):
//   • Nome do aluno        (fn)
//   • Idade                (fi)  -> o curso é derivado depois pela idade
//   • Responsável          (rn)
//   • Telefone             (wn)
//   • Bairro               (bairro)
//   • Consultor            (consultor) -> quem captou (vai pra nota + tag)
// Campos do evento (vêm embutidos no link, o consultor nem digita):
//   • Nome do evento       (evento)
//   • Local do evento      (local)
//   • Data do evento       (data)
//
// Grava o lead na etapa de entrada do funil Comercial 2026, com as tags
// "evento" + o nome do evento, registra o bairro e o filho nos campos, e
// adiciona uma NOTA legível com todos os dados do evento e do consultor.

const SUBDOMAIN   = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const PIPELINE_ID = 13965588;   // My Robot — Comercial 2026
const STATUS_ID   = 107779724;  // Etapa de entrada (Novo Lead)

const FIELD = {
  bairro: 3880749,
  origem: 3880751,
  filho:  3880753,
};

function txt(id, value) {
  if (!id || value == null || String(value).trim() === "") return null;
  return { field_id: id, values: [{ value: String(value) }] };
}
function normalizePhone(s) {
  if (!s) return "";
  let d = String(s).replace(/\D/g, "");
  if (d.length >= 10 && d.length <= 11) d = "55" + d; // BR local → +55
  return d ? "+" + d : "";
}

export default async function handler(req, res) {
  // CORS liberado (formulário é público, rodando no tablet dos consultores)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não configurado na Vercel" });

  // ---- MODO DIAGNÓSTICO: GET ?diag=myrobot2026 lista os campos de lead e as opções ----
  if (req.method === "GET") {
    if ((req.query.diag || "") !== "myrobot2026") {
      return res.status(403).json({ error: "diag key inválida" });
    }
    try {
      const r = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/leads/custom_fields?limit=250`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json().catch(() => ({}));
      const campos = (data?._embedded?.custom_fields || []).map((f) => ({
        id: f.id,
        nome: f.name,
        tipo: f.type,
        opcoes: (f.enums || []).map((e) => ({ id: e.id, valor: e.value })),
      }));
      return res.status(200).json({ ok: true, campos });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const b = req.body || {};

    const idade = b.fi ? `${String(b.fi).replace(/\D/g, "")} anos` : "";
    const filho = [b.fn, idade].filter(Boolean).join(" — ");
    const evento = b.evento || "Evento";

    // Campos do lead
    const leadFields = [
      txt(FIELD.bairro, b.bairro),
      txt(FIELD.origem, "evento"),   // origem padronizada = evento
      txt(FIELD.filho, filho),
    ].filter(Boolean);

    // Contato
    const contactFields = [];
    const phone = normalizePhone(b.wn);
    if (phone) contactFields.push({ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] });

    // Tags: evento + nome do evento (pra filtrar por evento específico)
    const tags = [{ name: "evento" }];
    if (b.evento) tags.push({ name: String(b.evento).slice(0, 40) });

    const payload = [{
      name: `Evento — ${b.fn || "aluno(a)"} (${b.rn || "responsável"})`,
      pipeline_id: PIPELINE_ID,
      status_id: STATUS_ID,
      custom_fields_values: leadFields,
      _embedded: {
        contacts: [{ name: b.rn || b.fn || "Lead de evento", custom_fields_values: contactFields }],
        tags,
      },
    }];

    const r = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/leads/complex`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Kommo erro:", r.status, JSON.stringify(data));
      return res.status(502).json({ error: "Kommo recusou", status: r.status, data });
    }

    // Pega o lead_id criado pra anexar a nota do evento
    const leadId = data?._embedded?.leads?.[0]?.id || data?.[0]?.id;
    let notaOk = false;
    if (leadId) {
      const linhas = [
        "CAPTAÇÃO EM EVENTO",
        `Evento: ${b.evento || "-"}`,
        `Local: ${b.local || "-"}`,
        `Data: ${b.data || "-"}`,
        `Consultor: ${b.consultor || "-"}`,
        "",
        `Aluno: ${b.fn || "-"}`,
        `Idade: ${idade || "-"}`,
        `Responsável: ${b.rn || "-"}`,
        `Telefone: ${b.wn || "-"}`,
        `Bairro: ${b.bairro || "-"}`,
        "",
        "Isca entregue: voucher R$ 150",
      ].join("\n");
      const nr = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ note_type: "common", params: { text: linhas } }]),
      });
      notaOk = nr.ok;
    }

    return res.status(200).json({ ok: true, feito: { lead: !!leadId, nota: notaOk }, lead_id: leadId });
  } catch (err) {
    console.error("Falha geral:", err);
    return res.status(500).json({ error: String(err) });
  }
}
