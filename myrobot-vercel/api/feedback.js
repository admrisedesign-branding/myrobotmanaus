// Recebe as telas de feedback (matriculados e evento) e grava no Capta.
//
// Substitui o api/kommo-feedback.js, que gravava direto no Kommo e em lugar
// nenhum mais — saindo do Kommo, essas respostas iriam para o nada. Agora
// viram linha de pesquisa no Capta, com NPS, comentário e o resto do
// formulário.
//
// O token fica aqui, no servidor: a página nunca o vê.
//
// Variáveis: CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const base  = process.env.CAPTA_URL  || "https://capta.riseagencia.com";
  const slug  = process.env.CAPTA_SLUG || "my-robot-manaus";
  const token = process.env.CAPTA_TOKEN;
  if (!token) {
    console.warn("CAPTA_TOKEN ausente: feedback não foi gravado");
    // não derruba a tela: quem respondeu segue para o agradecimento
    return res.status(200).json({ ok: false, motivo: "sem token" });
  }

  try {
    const b = req.body || {};
    const nps = (b.nps === 0 || b.nps) ? Number(b.nps) : null;
    // "evento: Feira X" → pesquisa própria do evento; sem isso, é a dos matriculados
    const pesquisa = b.origem_feedback
      ? String(b.origem_feedback).slice(0, 80)
      : "Matriculados";

    const corpo = {
      slug, token,
      pesquisa,
      telefone: String(b.telefone || "").replace(/\D/g, ""),
      nota: nps,
      comentario: String(b.comentario || "").trim(),
      canal: "site",
      respostas: {
        responsavel: String(b.responsavel || "").trim() || undefined,
        aluno: String(b.aluno || "").trim() || undefined,
        email: String(b.email || "").trim() || undefined,
        bairro: String(b.bairro || "").trim() || undefined,
        permite_uso: !!b.permite_uso,
        // id do lead no Kommo, só como referência do histórico; o Capta acha
        // o lead pelo telefone
        kommo_lead_id: String(b.lead_id || "").replace(/\D/g, "") || undefined,
      },
    };

    const r = await fetch(`${base}/api/capta-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    if (!r.ok) {
      console.error("Capta feedback:", r.status, await r.text().catch(() => ""));
      return res.status(200).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Falha ao gravar feedback:", err);
    // a tela de agradecimento não pode depender disso
    return res.status(200).json({ ok: false });
  }
}
