// api/kommo-lead.js
// Cria o lead na Kommo a partir do formulário do site My Robot Manaus.
// Já vem com TODOS os IDs reais preenchidos. A única coisa que você precisa
// configurar é a variável de ambiente KOMMO_TOKEN na Vercel (instruções no fim).
// ─── CONFIG (já preenchido com os dados reais da conta) ─────────────────────
const SUBDOMAIN  = "roboticanorte";
const PIPELINE_ID = 13965588;   // My Robot — Comercial 2026
const STATUS_ID   = 107779724;  // Etapa de entrada (Novo Lead)
const FIELD = {
  score:     3880739,  // Numérico
  categoria: 3880741,  // Lista (Selecionar)
  area:      3880743,
  trilha:    3880745,
  momento:   3880747,
  bairro:    3880749,
  origem:    3880751,
  filho:     3880753,
};
// Opções do campo "Categoria" (select) → id de cada opção na Kommo
const CATEGORIA_ENUM = { Quente: 4299211, Morno: 4299213, Frio: 4299215 };
// ────────────────────────────────────────────────────────────────────────────
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
function normalizePhone(s) {
  if (!s) return "";
  let d = String(s).replace(/\D/g, "");
  if (d.length >= 10 && d.length <= 11) d = "55" + d; // BR local → +55
  return d ? "+" + d : "";
}
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não configurado na Vercel" });
  try {
    const b = req.body || {};
    const score = Number(b.score) || 0;
    const filho = [b.fn, b.fi ? b.fi + " anos" : ""].filter(Boolean).join(" — ");
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
    const contactFields = [];
    const phone = normalizePhone(b.wn);
    if (phone) contactFields.push({ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] });
    if (b.em) contactFields.push({ field_code: "EMAIL", values: [{ value: b.em, enum_code: "WORK" }] });
    const cat = (["Quente", "Morno", "Frio"].find((k) =>
      String(b.categoria || "").toLowerCase().includes(k.toLowerCase())) || "Frio");
    const payload = [{
      name: `Site — ${b.fn || "filho(a)"} (${b.rn || "responsável"})`,
      pipeline_id: PIPELINE_ID,
      status_id: STATUS_ID,
      custom_fields_values: leadFields,
      _embedded: {
        contacts: [{ name: b.rn || b.fn || "Lead do site", custom_fields_values: contactFields }],
        tags: [{ name: "site" }, { name: cat }],
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
    return res.status(200).json({ ok: true, kommo: data });
  } catch (err) {
    console.error("Falha geral:", err);
    return res.status(500).json({ error: String(err) });
  }
}
