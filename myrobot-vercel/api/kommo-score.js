// /api/kommo-score.js
// Calcula Score + Categoria do lead a partir das respostas do bot (Momento + Bairro).
// É chamada por um webhook da Kommo no FIM do bot QUALIFICA WHATSAPP.
//
// Régua (fiel ao site):
//   Momento: 1=matricular(50) 2=aula(30) 3=pesquisando(10) 4=conhecendo(5)
//   Bairro:  1..6 = nobre (+20) | 7 = outro (+0)
//   Categoria: >=70 Quente | >=30 Morno | resto Frio

const SUBDOMAIN = 'roboticanorte';
const BASE = `https://${SUBDOMAIN}.kommo.com/api/v4`;

// IDs reais dos campos (Funil School)
const FIELD = {
  score: 3880739,      // numérico
  categoria: 3880741,  // select
  momento: 3880747,    // onde o bot salvou "1".."4"
  bairro: 3880749,     // onde o bot salvou "1".."7"
};

// enum_id das opções do campo Categoria
const CATEGORIA_ENUM = {
  quente: 4299211,
  morno: 4299213,
  frio: 4299215,
};

const MOMENTO_PTS = { '1': 50, '2': 30, '3': 10, '4': 5 };

// (Opcional) trava simples: se você definir a env var SCORE_SECRET,
// a função só roda se a chamada vier com ?key=<esse valor>.
function checkSecret(query) {
  const secret = process.env.SCORE_SECRET;
  if (!secret) return true; // sem segredo definido = aberto (ok pra MVP)
  return query && query.key === secret;
}

// Extrai o primeiro dígito permitido de um texto ("1", "quero 1", etc.)
function pickDigit(raw, allowed) {
  if (raw == null) return null;
  for (const ch of String(raw)) if (allowed.includes(ch)) return ch;
  return null;
}

async function getLead(id, token) {
  const r = await fetch(`${BASE}/leads/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`GET lead ${id} falhou: ${r.status}`);
  return r.json();
}

function readField(lead, fieldId) {
  const cfv = (lead && lead.custom_fields_values) || [];
  const f = cfv.find((c) => c.field_id === fieldId);
  if (!f || !f.values || !f.values.length) return null;
  return f.values[0].value;
}

async function patchLead(id, token, score, categoriaEnumId) {
  const body = {
    custom_fields_values: [
      { field_id: FIELD.score, values: [{ value: String(score) }] },
      { field_id: FIELD.categoria, values: [{ enum_id: categoriaEnumId }] },
    ],
  };
  const r = await fetch(`${BASE}/leads/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH lead ${id} falhou: ${r.status} ${await r.text()}`);
  return r.json();
}

// Acha o lead id em vários formatos possíveis de webhook
function extractLeadId(body, query) {
  if (query && query.lead_id) return query.lead_id;           // ?lead_id=123 (recomendado)
  if (body && body.lead_id) return body.lead_id;
  // formato webhook padrão da Kommo (aninhado)
  const paths = [
    ['leads', 'status', '0', 'id'],
    ['leads', 'update', '0', 'id'],
    ['leads', 'add', '0', 'id'],
  ];
  for (const p of paths) {
    let node = body, ok = true;
    for (const k of p) {
      if (node && typeof node === 'object' && k in node) node = node[k];
      else { ok = false; break; }
    }
    if (ok && node) return node;
  }
  // chaves "achatadas" (Vercel às vezes não aninha)
  for (const k of ['leads[status][0][id]', 'leads[update][0][id]', 'leads[add][0][id]']) {
    if (body && body[k]) return body[k];
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    const token = process.env.KOMMO_TOKEN;
    if (!token) return res.status(500).json({ error: 'KOMMO_TOKEN ausente' });
    if (!checkSecret(req.query || {})) return res.status(401).json({ error: 'chave inválida' });

    // Log pra depurar o formato do webhook na primeira vez
    console.log('BODY:', JSON.stringify(req.body));
    console.log('QUERY:', JSON.stringify(req.query));

    const leadId = extractLeadId(req.body || {}, req.query || {});
    if (!leadId) return res.status(400).json({ error: 'lead_id não encontrado', body: req.body });

    const lead = await getLead(leadId, token);
    const mDigit = pickDigit(readField(lead, FIELD.momento), ['1', '2', '3', '4']);
    const bDigit = pickDigit(readField(lead, FIELD.bairro), ['1', '2', '3', '4', '5', '6', '7']);

    const momentoPts = mDigit ? (MOMENTO_PTS[mDigit] || 0) : 0;
    const bairroNobre = bDigit && bDigit !== '7';
    const score = momentoPts + (bairroNobre ? 20 : 0);

    let categoriaEnumId;
    if (score >= 70) categoriaEnumId = CATEGORIA_ENUM.quente;
    else if (score >= 30) categoriaEnumId = CATEGORIA_ENUM.morno;
    else categoriaEnumId = CATEGORIA_ENUM.frio;

    await patchLead(leadId, token, score, categoriaEnumId);

    return res.status(200).json({ ok: true, leadId, momento: mDigit, bairro: bDigit, score });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
