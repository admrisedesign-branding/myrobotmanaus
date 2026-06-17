// api/create-pipeline.js
// ⚠️ ARQUIVO TEMPORÁRIO — usar uma vez e APAGAR depois.
//
// Cria o funil "My Robot — Comercial 2026" usando o KOMMO_TOKEN que já está
// nas variáveis de ambiente da Vercel. O token NUNCA sai do servidor.
//
// COMO USAR:
//   1) Coloca este arquivo em  myrobot-vercel/api/create-pipeline.js  no GitHub.
//   2) Espera a Vercel fazer o deploy.
//   3) Abre no navegador:
//        https://myrobotmanaus.com/api/create-pipeline?key=myrobot2026
//   4) Copia o JSON que aparecer e manda pro Claude.
//   5) APAGA este arquivo do repo (faz outro commit removendo).
//
// É seguro abrir mais de uma vez: se o funil já existir, ele NÃO duplica —
// só devolve os IDs do que já está lá.

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const NOME_FUNIL = "My Robot — Comercial 2026";

export default async function handler(req, res) {
  // guarda simples pra ninguém disparar isso por acaso (troque se quiser)
  if (req.query.key !== "myrobot2026") {
    return res.status(403).json({ error: "key inválida" });
  }

  const token = process.env.KOMMO_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "KOMMO_TOKEN não está nas env vars da Vercel" });
  }

  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://${SUBDOMAIN}.kommo.com/api/v4/leads/pipelines`;

  const resumo = (p) => ({
    pipeline_id: p.id,
    pipeline_name: p.name,
    statuses: p._embedded.statuses.map((s) => ({ id: s.id, name: s.name, sort: s.sort })),
  });

  try {
    // 1) Já existe um funil com esse nome? Se sim, não duplica — devolve ele.
    const listR = await fetch(base, { headers: auth });
    const listData = await listR.json().catch(() => ({}));
    const existente = listData?._embedded?.pipelines?.find((p) => p.name === NOME_FUNIL);
    if (existente) {
      return res.status(200).json({ ok: true, jaExistia: true, resumo: resumo(existente) });
    }

    // 2) Cria o funil com as 7 etapas (won/lost 142/143 entram sozinhas).
    const payload = [{
      name: NOME_FUNIL,
      is_main: false,
      _embedded: {
        statuses: [
          { name: "🆕 Novo Lead", sort: 10 },
          { name: "💬 Em Contato", sort: 20 },
          { name: "✅ Qualificado", sort: 30 },
          { name: "📅 Aula Agendada", sort: 40 },
          { name: "🎓 Matrícula em Andamento", sort: 50 },
          { name: "👤 Aluno Ativo", sort: 60 },
          { name: "🔄 Remarketing", sort: 70 },
        ],
      },
    }];

    const r = await fetch(base, { method: "POST", headers: auth, body: JSON.stringify(payload) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: "Kommo recusou", status: r.status, data });
    }

    return res.status(200).json({ ok: true, criado: true, resumo: resumo(data._embedded.pipelines[0]) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
