// Recebe a captação de leads em evento (o app que o captador usa no estande)
// e grava no Capta.
//
// AINDA NÃO LIGADO. A evento-captacao.html continua chamando o
// api/kommo-evento.js de propósito: o relatório do estande
// (api/relatorio-evento.js, 343 linhas) lê os leads do evento PELA TAG NO
// KOMMO. Trocar só a captação deixaria o captador com relatório vazio no meio
// do evento. Os dois têm que mudar na mesma passada — quando o relatório
// passar a ler do Capta, é só apontar a tela para cá.
//
// Vai substituir o api/kommo-evento.js, que grava direto no Kommo. O lead entra
// com porta "evento", o nome do evento e o local vão nas anotações, e os
// filhos ficam todos registrados — o Capta guarda a criança principal nos
// campos próprios e a lista inteira na anotação, como o Kommo recebia.
//
// Variáveis: CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const base  = process.env.CAPTA_URL  || "https://capta.riseagencia.com";
  const slug  = process.env.CAPTA_SLUG || "my-robot-manaus";
  const token = process.env.CAPTA_TOKEN;
  if (!token) {
    console.warn("CAPTA_TOKEN ausente: lead do evento não foi gravado");
    return res.status(200).json({ ok: false, motivo: "sem token" });
  }

  try {
    const b = req.body || {};
    const fone = String(b.wn || "").replace(/\D/g, "");
    if (!fone) return res.status(400).json({ error: "wn (WhatsApp) é obrigatório" });

    const filhos = Array.isArray(b.filhos) && b.filhos.length
      ? b.filhos
      : [{ nome: b.fn, idade: b.fi }];
    const limpos = filhos
      .map((f) => ({ nome: String((f && f.nome) || "").trim(), idade: Number(String((f && f.idade) || "").replace(/\D/g, "")) || null }))
      .filter((f) => f.nome);

    const linha = (rot, v) => (v ? `${rot}: ${String(v).trim()}` : null);
    const notas = [
      "Captação em evento",
      linha("Evento", b.evento),
      linha("Local", b.local),
      linha("Data", b.data),
      linha("Captador", b.consultor),
      linha("Bairro", b.bairro),
      limpos.length ? "Filhos: " + limpos.map((f) => f.nome + (f.idade ? ` (${f.idade})` : "")).join(", ") : null,
    ].filter(Boolean).join(" · ");

    const corpo = {
      slug, token,
      nome: String(b.rn || "").trim() || "Lead de evento",
      contato: fone,
      origem: "evento",
      extra: {
        fonte: "evento",
        porta: "evento",
        crianca: limpos[0] ? limpos[0].nome : undefined,
        idade: limpos[0] && limpos[0].idade ? limpos[0].idade : undefined,
        notas,
      },
      tags: [String(b.evento || "evento").toLowerCase().trim().replace(/\s+/g, "-").slice(0, 40)].filter(Boolean),
    };

    const c = b.consentimento;
    if (c && c.contato) {
      corpo.consentimento = {
        canal: "evento", contato: true,
        dados_crianca: !!c.dados_crianca, marketing: !!c.marketing, responsavel: !!c.responsavel,
        versao: String(c.versao || "evento-v1"),
        texto: String(c.texto || "").slice(0, 1000),
      };
    }

    const r = await fetch(`${base}/api/capta-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    if (!r.ok) {
      console.error("Capta ingest (evento):", r.status, await r.text().catch(() => ""));
      return res.status(200).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Falha ao gravar lead de evento:", err);
    // o captador está num estande: a tela não pode travar
    return res.status(200).json({ ok: false });
  }
}
