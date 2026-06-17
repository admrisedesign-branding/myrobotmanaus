// api/create-pipeline.js
// ⚠️ ARQUIVO TEMPORÁRIO — usar e APAGAR depois.
// Cria/repara o funil "My Robot — Comercial 2026" usando o KOMMO_TOKEN da Vercel
// (o token nunca sai do servidor).
//
// Abrir:  https://myrobotmanaus.com/api/create-pipeline?key=myrobot2026
// Pode abrir mais de uma vez: não duplica o funil e corrige os nomes das etapas.

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const NOME_FUNIL = "My Robot — Comercial 2026";

// O Kommo não guarda emoji de 4 bytes em nome de etapa (salva vazio),
// então usamos texto limpo. Mapa por 'sort' (ordem fixa das etapas).
const NOMES = {
  20: "Novo Lead",
  30: "Em Contato",
  40: "Qualificado",
  50: "Aula Agendada",
  60: "Matrícula em Andamento",
  70: "Aluno Ativo",
  80: "Remarketing",
};

export default async function handler(req, res) {
  if (req.query.key !== "myrobot2026") return res.status(403).json({ error: "key inválida" });

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não está nas env vars da Vercel" });

  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://${SUBDOMAIN}.kommo.com/api/v4/leads/pipelines`;

  const resumo = (p) => ({
    pipeline_id: p.id,
    pipeline_name: p.name,
    statuses: p._embedded.statuses.map((s) => ({ id: s.id, name: s.name, sort: s.sort })),
  });

  try {
    // 1) Acha o funil pelo nome
    const listR = await fetch(base, { headers: auth });
    const listData = await listR.json().catch(() => ({}));
    let pipe = listData?._embedded?.pipelines?.find((p) => p.name === NOME_FUNIL);

    // 2) Se não existir, cria (com nomes em texto limpo)
    if (!pipe) {
      const payload = [{
        name: NOME_FUNIL,
        is_main: false,
        is_unsorted_on: true,
        sort: 3,
        _embedded: {
          statuses: [
            { name: "Novo Lead", sort: 20 },
            { name: "Em Contato", sort: 30 },
            { name: "Qualificado", sort: 40 },
            { name: "Aula Agendada", sort: 50 },
            { name: "Matrícula em Andamento", sort: 60 },
            { name: "Aluno Ativo", sort: 70 },
            { name: "Remarketing", sort: 80 },
          ],
        },
      }];
      const r = await fetch(base, { method: "POST", headers: auth, body: JSON.stringify(payload) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: "Kommo recusou", status: r.status, data });
      pipe = data._embedded.pipelines[0];
    }

    // 3) Repara nomes vazios/errados das 7 etapas (mapeando por sort)
    let corrigidos = 0;
    for (const s of pipe._embedded.statuses) {
      const alvo = NOMES[s.sort];
      if (alvo && s.name !== alvo) {
        const pr = await fetch(`${base}/${pipe.id}/statuses/${s.id}`, {
          method: "PATCH", headers: auth, body: JSON.stringify({ name: alvo }),
        });
        if (pr.ok) corrigidos++;
      }
    }

    // 4) Relê o funil pra devolver o estado final
    const finalR = await fetch(`${base}/${pipe.id}`, { headers: auth });
    const finalData = await finalR.json().catch(() => pipe);

    return res.status(200).json({ ok: true, corrigidos, resumo: resumo(finalData) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
