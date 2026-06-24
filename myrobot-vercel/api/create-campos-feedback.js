// api/create-campos-feedback.js
// ⚠️ ARQUIVO TEMPORÁRIO — usar uma vez e APAGAR depois.
//
// Cria, nos CONTATOS do Kommo, os campos personalizados do feedback:
//   • NPS (numérico)
//   • Classificação NPS (lista: Promotor / Neutro / Detrator)
//   • Depoimento (texto longo)
//   • Autoriza uso do depoimento (caixa de seleção)
//
// É idempotente: se um campo já existir, não duplica.
// Abrir: https://myrobotmanaus.com/api/create-campos-feedback?key=myrobot2026

export const config = { maxDuration: 30 };
const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "roboticanorte";

const ALVO = [
  { name: "NPS", type: "numeric" },
  { name: "Classificação NPS", type: "select", enums: ["Promotor", "Neutro", "Detrator"] },
  { name: "Depoimento", type: "textarea" },
  { name: "Autoriza uso do depoimento", type: "checkbox" },
];

export default async function handler(req, res) {
  if (req.query.key !== "myrobot2026") return res.status(403).json({ error: "key inválida" });
  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN ausente" });

  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://${SUBDOMAIN}.kommo.com/api/v4/contacts/custom_fields`;

  try {
    // lê campos existentes (pra não duplicar)
    const existentes = {};
    let page = 1;
    while (page <= 20) {
      const r = await fetch(`${base}?limit=250&page=${page}`, { headers: auth });
      if (r.status === 204) break;
      if (!r.ok) return res.status(502).json({ error: "Kommo recusou (listar)", status: r.status });
      const d = await r.json().catch(() => ({}));
      const cfs = d?._embedded?.custom_fields || [];
      if (!cfs.length) break;
      for (const f of cfs) existentes[f.name] = f;
      if (!d?._links?.next) break;
      page++;
    }

    // cria só os que faltam
    const criar = ALVO.filter((a) => !existentes[a.name]).map((a) => {
      const o = { name: a.name, type: a.type };
      if (a.enums) o.enums = a.enums.map((v) => ({ value: v }));
      return o;
    });

    let criados = [];
    if (criar.length) {
      const r = await fetch(base, { method: "POST", headers: auth, body: JSON.stringify(criar) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: "Kommo recusou (criar)", status: r.status, data: d });
      criados = d?._embedded?.custom_fields || [];
      for (const f of criados) existentes[f.name] = f;
    }

    const resumo = ALVO.map((a) => {
      const f = existentes[a.name] || {};
      const out = { campo: a.name, id: f.id, type: f.type };
      if (f.enums) out.enums = f.enums.map((e) => ({ id: e.id, value: e.value }));
      return out;
    });

    return res.status(200).json({ ok: true, criados_agora: criados.length, campos: resumo });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
