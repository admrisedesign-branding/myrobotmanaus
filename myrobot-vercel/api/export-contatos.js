// api/export-contatos.js
// ⚠️ ARQUIVO TEMPORÁRIO — usar e APAGAR depois.
//
// Exporta TODOS os contatos do CRM Kommo num CSV pronto para o Meta
// (Lista de Clientes → Público Personalizado). O KOMMO_TOKEN fica no servidor.
//
// USO:
//   • Baixar o CSV:   https://myrobotmanaus.com/api/export-contatos?key=myrobot2026
//   • Só ver números: https://myrobotmanaus.com/api/export-contatos?key=myrobot2026&stats=1
//
// Depois de baixar, APAGUE este arquivo do repo.

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "roboticanorte";

// Telefone -> padrão internacional E.164 (+55...)
function normalizePhone(s) {
  if (!s) return "";
  let d = String(s).replace(/\D/g, "");
  if (!d) return "";
  // remove zeros à esquerda
  d = d.replace(/^0+/, "");
  // BR local (10-11 dígitos, DDD + número) -> prefixa 55
  if (d.length >= 10 && d.length <= 11) d = "55" + d;
  return "+" + d;
}

// quebra "Nome Sobrenome" em primeiro/último
function splitName(name) {
  const n = String(name || "").trim().replace(/\s+/g, " ");
  if (!n) return ["", ""];
  const parts = n.split(" ");
  const fn = parts.shift();
  const ln = parts.join(" ");
  return [fn, ln];
}

// escapa campo CSV
function csv(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default async function handler(req, res) {
  if (req.query.key !== "myrobot2026") return res.status(403).json({ error: "key inválida" });
  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não está nas env vars da Vercel" });

  const auth = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.kommo.com/api/v4/contacts`;

  try {
    const vistos = new Set();   // dedup por telefone|email
    const linhas = [];          // {email, phone, fn, ln}
    let totalContatos = 0, comTelefone = 0, comEmail = 0;

    let page = 1;
    const LIMIT = 250;
    const MAX_PAGES = 60; // trava de segurança (~15 mil contatos)

    while (page <= MAX_PAGES) {
      const r = await fetch(`${base}?limit=${LIMIT}&page=${page}`, { headers: auth });
      if (r.status === 204) break;             // sem mais conteúdo
      if (!r.ok) return res.status(502).json({ error: "Kommo recusou", status: r.status, page });
      const data = await r.json().catch(() => ({}));
      const contatos = data?._embedded?.contacts || [];
      if (contatos.length === 0) break;

      for (const c of contatos) {
        totalContatos++;
        const cfs = c.custom_fields_values || [];
        const phoneField = cfs.find((f) => f.field_code === "PHONE");
        const emailField = cfs.find((f) => f.field_code === "EMAIL");

        const phones = (phoneField?.values || []).map((v) => normalizePhone(v.value)).filter(Boolean);
        const emails = (emailField?.values || []).map((v) => String(v.value || "").trim().toLowerCase()).filter(Boolean);

        if (phones.length) comTelefone++;
        if (emails.length) comEmail++;
        if (!phones.length && !emails.length) continue; // sem dado útil pro Meta

        const [fn, ln] = splitName(c.name);
        // gera uma linha por combinação útil (prioriza ter telefone E email juntos)
        const phone = phones[0] || "";
        const email = emails[0] || "";
        const chave = phone + "|" + email;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        linhas.push({ email, phone, fn, ln });
      }

      if (!data?._links?.next) break; // última página
      page++;
    }

    // modo "stats": só os números, sem baixar
    if (req.query.stats === "1") {
      return res.status(200).json({
        ok: true,
        total_contatos_lidos: totalContatos,
        com_telefone: comTelefone,
        com_email: comEmail,
        linhas_no_csv: linhas.length,
        paginas_lidas: page,
      });
    }

    // monta o CSV no formato do Meta
    const header = "email,phone,fn,ln,country";
    const rows = linhas.map((l) => [csv(l.email), csv(l.phone), csv(l.fn), csv(l.ln), "BR"].join(","));
    const conteudo = "\uFEFF" + [header, ...rows].join("\n"); // BOM p/ acentos

    const hoje = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="myrobot-leads-meta-${hoje}.csv"`);
    return res.status(200).send(conteudo);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
