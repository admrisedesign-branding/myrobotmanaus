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
  score:        3880739,  // numeric
  categoria:    3880741,  // select
  bairro:       3880749,
  origem:       3880751,
  filho:        3880753,
  comportamento:3881421,  // multiselect
};

// IDs das opções (do diagnóstico)
const CATEGORIA = { Quente: 4299211, Morno: 4299213, Frio: 4299215 };
const COMPORT_EVENTO = 4299859; // "Participou de evento"

// Bairros nobres (público quente). Comparação sem acento/maiúscula, por "contém".
const BAIRROS_NOBRES = [
  "adrianopolis", "ponta negra", "gracas", "vieiralves", "nossa senhora",
  "parque 10", "parque dez", "flores", "aleixo", "chapada", "dom pedro",
  "morada do sol", "conjunto morada", "sao francisco",
];
function semAcento(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function ehBairroNobre(bairro) {
  const b = semAcento(bairro);
  if (!b) return false;
  return BAIRROS_NOBRES.some((n) => b.includes(n));
}

function txt(id, value) {
  if (!id || value == null || String(value).trim() === "") return null;
  return { field_id: id, values: [{ value: String(value) }] };
}
function selectField(id, enumId) {
  if (!id || !enumId) return null;
  return { field_id: id, values: [{ enum_id: enumId }] };
}
function multiselectField(id, enumIds) {
  if (!id || !enumIds || !enumIds.length) return null;
  return { field_id: id, values: enumIds.map((e) => ({ enum_id: e })) };
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

    // Filhos: aceita a lista nova (b.filhos) e continua aceitando o par antigo (b.fn/b.fi).
    const listaFilhos = Array.isArray(b.filhos) && b.filhos.length
      ? b.filhos
      : [{ nome: b.fn, idade: b.fi }];
    const fmtFilho = (f) => {
      const n = String(f?.nome || "").trim();
      const id = String(f?.idade || "").replace(/\D/g, "");
      return [n, id ? `${id} anos` : ""].filter(Boolean).join(" — ");
    };
    const filhosTxt = listaFilhos.map(fmtFilho).filter(Boolean);
    const filho = filhosTxt.join(" · ");
    const idade = String(listaFilhos[0]?.idade || "").replace(/\D/g, "");
    const primeiroNome = String(listaFilhos[0]?.nome || "").trim();
    const evento = b.evento || "Evento";

    // ---- Qualificação automática ----
    // Bairro nobre => Quente (score 70). Fora da lista => Morno (score 50).
    const nobre = ehBairroNobre(b.bairro);
    const catId = nobre ? CATEGORIA.Quente : CATEGORIA.Morno;
    const score = nobre ? 70 : 50;

    // Campos do lead
    const leadFields = [
      txt(FIELD.score, score),
      selectField(FIELD.categoria, catId),
      multiselectField(FIELD.comportamento, [COMPORT_EVENTO]),
      txt(FIELD.bairro, b.bairro),
      txt(FIELD.origem, "evento"),   // origem padronizada = evento
      txt(FIELD.filho, filho),
    ].filter(Boolean);

    // Contato
    const contactFields = [];
    const phone = normalizePhone(b.wn);
    if (phone) contactFields.push({ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] });

    // Tags: evento + nome do evento + categoria (pra filtrar fácil)
    const tags = [{ name: "evento" }, { name: nobre ? "Quente" : "Morno" }];
    if (b.evento) tags.push({ name: String(b.evento).slice(0, 40) });

    const payload = [{
      name: `Evento — ${primeiroNome || "aluno(a)"}${listaFilhos.length > 1 ? ` +${listaFilhos.length - 1}` : ""} (${b.rn || "responsável"})`,
      pipeline_id: PIPELINE_ID,
      status_id: STATUS_ID,
      custom_fields_values: leadFields,
      _embedded: {
        contacts: [{ name: b.rn || primeiroNome || "Lead de evento", custom_fields_values: contactFields }],
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
        `Aluno(s): ${filho || "-"}`,
        `Idade: ${idade ? idade + " anos" : "-"}`,
        `Responsável: ${b.rn || "-"}`,
        `Telefone: ${b.wn || "-"}`,
        `Bairro: ${b.bairro || "-"}`,
        `Categoria: ${nobre ? "Quente" : "Morno"} (score ${score})`,
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
