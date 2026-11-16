// api/relatorio-evento.js
// Lê os leads de um evento NO CAPTA e devolve os dados agregados para o
// relatorio-evento.html e o leads-evento.html.
//
// Antes isso lia o Kommo. Em 16/11/2026 a assinatura do Kommo venceu (402) e a
// decisão foi sair dele de vez: quem guarda o lead agora é o Capta.
//
// O site não tem a chave de serviço do Supabase, então a leitura passa pela
// função capta_evento_leads(slug, token, evento), que valida o mesmo par
// slug+ingest_token já usado para gravar e devolve só os leads daquele evento.
//
// GET /api/relatorio-evento?evento=<nome>&key=myrobot2026
//     &debug=1      → o que existe no Capta, sem processar
const SUPABASE_URL  = process.env.CAPTA_SUPABASE_URL || "https://oaezsozoriqnkurxncjs.supabase.co";
const SUPABASE_ANON = process.env.CAPTA_SUPABASE_ANON;
const CAPTA_SLUG    = process.env.CAPTA_SLUG;
const CAPTA_TOKEN   = process.env.CAPTA_TOKEN;

const MANAUS_OFFSET_MS = 4 * 3600 * 1000;

async function rpc(nome, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Capta ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : [];
}

// "Miguel — 9 anos · Sofia — 7 anos" a partir do que o Capta guarda
function filhoTexto(l) {
  const nome = String(l.crianca || "").trim();
  const idade = String(l.idade || "").replace(/\D/g, "");
  if (!nome && !idade) return "—";
  return [nome, idade ? `${idade} anos` : ""].filter(Boolean).join(" — ");
}

// o consultor do estande vai na nota ("Consultor: X"); atendente é o fallback
function consultorDe(l) {
  const m = String(l.notas || "").match(/Consultor:\s*(.+)/i);
  if (m) {
    const v = m[1].split("\n")[0].trim();
    if (v && v !== "-") return v;
  }
  return l.atendente || "—";
}

// bairro não é coluna no Capta: ele vai na nota da captação
function bairroDe(l) {
  const m = String(l.notas || "").match(/Bairro:\s*(.+)/i);
  if (!m) return "—";
  const v = m[1].split("\n")[0].trim();
  return v && v !== "-" ? v : "—";
}

function localDe(l) {
  const m = String(l.notas || "").match(/Local:\s*(.+)/i);
  if (!m) return "";
  const v = m[1].split("\n")[0].trim();
  return v && v !== "-" ? v.split(/\s[-–—]\s/)[0].trim() : "";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if ((req.query.key || "") !== "myrobot2026") return res.status(403).json({ error: "key inválida" });

  const evento = String(req.query.evento || "").trim();
  if (!evento) return res.status(400).json({ error: "informe ?evento=" });
  if (!SUPABASE_ANON || !CAPTA_SLUG || !CAPTA_TOKEN) {
    return res.status(500).json({ error: "Capta não configurado (CAPTA_SUPABASE_ANON / CAPTA_SLUG / CAPTA_TOKEN)" });
  }

  try {
    const leads = await rpc("capta_evento_leads", {
      p_slug: CAPTA_SLUG,
      p_token: CAPTA_TOKEN,
      p_evento: evento,
    });

    if (req.query.debug) {
      return res.status(200).json({
        ok: true,
        debug: true,
        eventoProcurado: evento,
        leadsNoEvento: leads.length,
        amostra: leads.slice(0, 3),
      });
    }

    const porHora = {}, porDia = {}, porConsultor = {}, porBairro = {};
    const categorias = { Quente: 0, Morno: 0, Outro: 0 };
    const lista = [];
    let respondidos = 0, somaNps = 0, qtdNps = 0, autorizados = 0;

    for (const l of leads) {
      // tudo no fuso de Manaus: o dia do evento é o dia de lá, não UTC
      const d = new Date(new Date(l.criado_em).getTime() - MANAUS_OFFSET_MS);
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const diaISO = `${d.getUTCFullYear()}-${mo}-${dd}`;

      porHora[String(Number(hh))] = (porHora[String(Number(hh))] || 0) + 1;
      porDia[diaISO] = (porDia[diaISO] || 0) + 1;

      const categoria = /quente/i.test(l.temperatura || "") ? "Quente"
                      : /morno/i.test(l.temperatura || "") ? "Morno" : "Outro";
      categorias[categoria]++;

      const consultor = consultorDe(l);
      porConsultor[consultor] = (porConsultor[consultor] || 0) + 1;
      const bairro = bairroDe(l);
      if (bairro !== "—") porBairro[bairro] = (porBairro[bairro] || 0) + 1;

      const deuFeedback = l.respondida_em != null;
      const nps = typeof l.nps === "number" ? l.nps : null;
      if (deuFeedback) {
        respondidos++;
        if (nps != null) { somaNps += nps; qtdNps++; }
        if (l.comentario) autorizados++;
      }

      lista.push({
        id: l.id,
        hora: `${hh}:${mm}`,
        dia: `${dd}/${mo}`,
        diaISO,
        local: localDe(l),
        responsavel: l.nome || "—",
        filho: filhoTexto(l),
        telefone: l.contato || "—",
        bairro,
        categoria,
        consultor,
        deuFeedback,
        nps,
        comentario: l.comentario || null,
        autoriza: !!l.comentario,
      });
    }

    return res.status(200).json({
      ok: true,
      evento,
      total: leads.length,
      porHora,
      porDia,
      categorias,
      porConsultor,
      porBairro,
      feedback: {
        respondidos,
        npsMedio: qtdNps ? Math.round((somaNps / qtdNps) * 10) / 10 : null,
        autorizados,
        taxaResposta: leads.length ? Math.round((respondidos / leads.length) * 100) : 0,
      },
      lista,
    });
  } catch (err) {
    console.error("relatorio-evento:", err.message);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
