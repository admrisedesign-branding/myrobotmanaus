// Recebe o formulário do site e grava o lead no Capta.
//
// Substitui o antigo api/kommo-lead.js, que mandava o lead para o Kommo e, de
// passagem, para o Capta. O Capta funciona sozinho desde out/2026 — o último
// espelhamento para o Kommo foi 30/10 e nenhum lead veio de lá desde 05/11 —
// então o caminho do Kommo saiu e sobrou o que importa.
//
// Variáveis: CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    // sem await de propósito: quem preencheu não espera o Capta responder para
    // receber o botão do WhatsApp
    enviarAoCapta(req.body || {});
    return res.status(200).json({ ok: true, destino: "capta" });
  } catch (err) {
    console.error("Falha ao receber o lead:", err);
    return res.status(500).json({ error: String(err) });
  }
}

// ─── LGPD: consentimento → Capta ─────────────────────────────────────────────
// Variáveis (mesmas da captação de eventos): CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN
// O lead inteiro vai para o Capta, não só o consentimento. Antes ele chegava
// lá pelo espelho do Kommo — e em 18/set/2026 o Kommo bloqueou o IP da Vercel
// (403), deixando o Capta cego para o que entrava pelo site. Mandar direto
// tira essa dependência: se o Kommo cair, a operação continua.
function enviarAoCapta(b) {
  const base  = process.env.CAPTA_URL  || "https://capta.riseagencia.com";
  const slug  = process.env.CAPTA_SLUG || "my-robot-manaus";
  const token = process.env.CAPTA_TOKEN;
  if (!token) return;
  const fone = String(b.wn || "").replace(/\D/g, "");
  if (!fone) return;

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
    tags: Array.isArray(b.tags) ? b.tags.slice(0, 5) : undefined,   // tag de campanha (ex.: black-friday) → aparece no Capta
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
  // sem await de propósito: o lead não pode esperar o Capta
  fetch(`${base}/api/capta-ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
  }).catch((e) => console.warn("Capta ingest falhou:", e && e.message));
}

