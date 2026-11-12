// Recebe o formulário do site e grava o lead no Capta.
//
// Substitui o antigo api/kommo-lead.js, que mandava o lead para o Kommo e, de
// passagem, para o Capta. O Capta funciona sozinho desde out/2026 — o último
// espelhamento para o Kommo foi 30/10 e nenhum lead veio de lá desde 05/11 —
// então o caminho do Kommo saiu e sobrou o que importa.
//
// Variáveis: CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN

// De onde o lead veio, em etiqueta.
//
// Cada página manda a sua ("site-principal", "site-blackfriday") e aqui entra
// "anuncio" quando a UTM diz que a pessoa chegou por anúncio pago. A regra
// fica no servidor, e não nas duas páginas, para as duas contarem igual.
//
// Pago é: clique identificado do Facebook ou do Google (fbclid/gclid), ou
// utm_medium de mídia paga. Chegar por link do Instagram ou por busca
// orgânica NÃO é anúncio — nesses casos o MR_UTM grava medium "referral" ou
// "organic", e a etiqueta não entra.
function etiquetas(b) {
  const fora = Array.isArray(b.tags) ? b.tags.filter(Boolean).map(String) : [];
  const u = (b.utm && typeof b.utm === "object") ? b.utm : {};
  const meio = String(u.utm_medium || "").toLowerCase();
  const pago = !!(u.fbclid || u.gclid) || /^(cpc|ppc|paid|paidsocial|paid_social|cpm|display)$/.test(meio);
  if (pago) fora.push("anuncio");
  return fora.length ? [...new Set(fora)].slice(0, 5) : undefined;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    // COM await, e isso importa. O código antigo disparava e seguia sem
    // esperar, mas logo depois fazia várias idas ao Kommo — e era esse tempo
    // que mantinha a função viva até o envio ao Capta sair. Tirado o Kommo, a
    // resposta volta na hora, a Vercel congela a função e o fetch pendente
    // morre antes de chegar: o lead sumia sem erro nenhum.
    const r = await enviarAoCapta(req.body || {});
    return res.status(200).json({ ...r, destino: "capta" });
  } catch (err) {
    console.error("Falha ao receber o lead:", err);
    // a pessoa não pode ficar sem o botão do WhatsApp por causa disto
    return res.status(200).json({ ok: false });
  }
}

// ─── LGPD: consentimento → Capta ─────────────────────────────────────────────
// Variáveis (mesmas da captação de eventos): CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN
// O lead inteiro vai para o Capta, não só o consentimento. Antes ele chegava
// lá pelo espelho do Kommo — e em 18/set/2026 o Kommo bloqueou o IP da Vercel
// (403), deixando o Capta cego para o que entrava pelo site. Mandar direto
// tira essa dependência: se o Kommo cair, a operação continua.
async function enviarAoCapta(b) {
  const base  = process.env.CAPTA_URL  || "https://capta.riseagencia.com";
  const slug  = process.env.CAPTA_SLUG || "my-robot-manaus";
  const token = process.env.CAPTA_TOKEN;
  if (!token) { console.warn("CAPTA_TOKEN ausente"); return { ok: false, motivo: "sem token" }; }
  const fone = String(b.wn || "").replace(/\D/g, "");
  if (!fone) { console.warn("lead sem telefone"); return { ok: false, motivo: "sem telefone" }; }

  const c = b && b.consentimento;
  // Resumo no mesmo formato do bot do WhatsApp, para o atendente ver o mesmo perfil de qualquer porta.
  const cat = ["Quente", "Morno", "Frio"].find((k) => String(b.categoria || "").toLowerCase().includes(k.toLowerCase())) || "Frio";
  const linha = (rot, v) => (v ? `${rot}: ${String(v).trim()}` : null);
  const notas = [
    "Qualificação Site",
    linha("Bairro", b.bairro),
    linha("Interesse", b.area),
    linha("Momento", String(b.mom || "").replace(/^[^\p{L}]+/u, "")),
    linha("Objetivo", b.obj),
    linha("Contato prévio", b.cont),
    linha("Trilha", b.trilha),
    linha("Origem", b.orig),
    linha("Responsável", b.rn),
  ].filter(Boolean).join(" · ");
  const corpo = {
    slug, token,
    nome: String(b.rn || "").trim() || "Lead do site",
    contato: fone,
    origem: "site",
    extra: {
      fonte: "site",
      porta: "site",
      crianca: String(b.fn || "").trim() || undefined,
      idade: b.fi ? Number(String(b.fi).replace(/\D/g, "")) || undefined : undefined,
      
      email: String(b.em || "").trim() || undefined,
      curso: b.area || undefined,
      score: Number(b.score) || 0,
      temperatura: cat,
      notas,
    },
    tags: etiquetas(b),
    respostas: b.respostas || undefined,
    utm: (b.utm && typeof b.utm === 'object') ? b.utm : undefined,   // campanha/grupo do anúncio → rastreio no Capta
  };
  if (c && c.contato) {
    corpo.consentimento = {
      canal: "site", contato: true,
      dados_crianca: !!c.dados_crianca, marketing: !!c.marketing, responsavel: !!c.responsavel,
      versao: String(c.versao || "site-v1"),
      texto: String(c.texto || "").slice(0, 1000),
      url: c.url || null,
    };
  }
  try {
    const r = await fetch(`${base}/api/capta-ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    });
    const txt = await r.text().catch(() => "");
    if (!r.ok) { console.error("Capta ingest:", r.status, txt); return { ok: false, status: r.status, resposta: txt.slice(0, 200) }; }
    return { ok: true, status: r.status, resposta: txt.slice(0, 200) };
  } catch (e) {
    console.error("Capta ingest falhou:", e && e.message);
    return { ok: false, motivo: String(e && e.message).slice(0, 120) };
  }
}

