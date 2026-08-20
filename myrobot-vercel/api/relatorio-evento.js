// api/relatorio-evento.js
// Lê os leads de um evento (pela TAG) no Kommo e devolve os dados agregados
// para o dashboard (relatorio-evento.html). Reutilizável: passe ?evento=NOME
// da tag do evento (ex.: ?evento=Robô Humanoide - Plaza (19/08)).
//
// GET /api/relatorio-evento?evento=<tag>&key=myrobot2026
// Retorna JSON com: total, porHora, categorias, porConsultor, porBairro,
// feedback (respondidos, npsMedio, autorizados) e a lista crua (opcional).

const SUBDOMAIN   = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const PIPELINE_ID = 13965588;

const FIELD = {
  score:     3880739,
  categoria: 3880741,
  bairro:    3880749,
  origem:    3880751,
};
// campos de feedback (no contato)
const F_NPS = null; // resolvido por nome abaixo (varia), usamos a nota da timeline como reforço
const CAT_QUENTE = 4299211;

function getCF(entity, fieldId) {
  const cf = (entity.custom_fields_values || []).find((f) => f.field_id === fieldId);
  return cf ? (cf.values?.[0]?.value ?? null) : null;
}
function getCFEnum(entity, fieldId) {
  const cf = (entity.custom_fields_values || []).find((f) => f.field_id === fieldId);
  return cf ? (cf.values?.[0]?.enum_id ?? null) : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não configurado" });
  if ((req.query.key || "") !== "myrobot2026") return res.status(403).json({ error: "key inválida" });

  const eventoTag = String(req.query.evento || "").trim();
  if (!eventoTag) return res.status(400).json({ error: "informe ?evento=<tag>" });

  const auth = { Authorization: `Bearer ${token}` };
  const api = `https://${SUBDOMAIN}.kommo.com/api/v4`;

  try {
    // 1) Busca os leads do FUNIL (paginando) e filtra pela tag do evento aqui.
    //    Atenção: filter[tags][0] do Kommo espera o ID numérico da tag, não o
    //    nome — passar o nome devolvia lista vazia sempre. Por isso o filtro
    //    pelo nome da tag é feito no código, abaixo.
    let leads = [];
    let page = 1;
    for (;;) {
      const url = `${api}/leads?filter[pipeline_id]=${PIPELINE_ID}`
        + `&with=contacts&limit=250&page=${page}`;
      const r = await fetch(url, { headers: auth });
      if (!r.ok) break;
      const data = await r.json().catch(() => ({}));
      const batch = data?._embedded?.leads || [];
      leads = leads.concat(batch);
      if (batch.length < 250) break;
      page++;
      if (page > 20) break; // trava de segurança
    }

    const totalFunil = leads.length;
    const tagsDoLead = (l) => (l._embedded?.tags || []).map((t) => String(t.name || ""));
    const todasTags = new Set();
    leads.forEach((l) => tagsDoLead(l).forEach((t) => todasTags.add(t)));

    // a gravação corta a tag em 40 caracteres (ver api/kommo-evento.js),
    // então comparamos também com o nome cortado
    const alvo = eventoTag.toLowerCase();
    const alvoCurto = alvo.slice(0, 40);
    leads = leads.filter((l) =>
      tagsDoLead(l).some((t) => {
        const n = t.toLowerCase();
        return n === alvo || n === alvoCurto;
      })
    );

    // ?debug=1 -> mostra o que existe no funil, sem processar nada
    // ?debug=campos -> mostra os campos crus do lead e do contato (pra achar
    //                  por que o feedback ou o filho não aparecem no card)
    if (req.query.debug) {
      const base = {
        ok: true,
        debug: true,
        eventoProcurado: eventoTag,
        leadsNoFunil: totalFunil,
        leadsComEssaTag: leads.length,
        tagsExistentesNoFunil: Array.from(todasTags).sort(),
      };
      if (String(req.query.debug) !== "campos") return res.status(200).json(base);

      // catálogo de campos de LEAD da conta (id + nome + tipo), pra conferir
      // se o FIELD.filho usado na gravação é mesmo o campo certo
      const catalogo = [];
      let cp = 1;
      while (cp <= 10) {
        const cr = await fetch(`${api}/leads/custom_fields?limit=250&page=${cp}`, { headers: auth });
        if (cr.status === 204 || !cr.ok) break;
        const cd = await cr.json().catch(() => ({}));
        const cfs = cd?._embedded?.custom_fields || [];
        if (!cfs.length) break;
        cfs.forEach((f) => catalogo.push({ id: f.id, nome: f.name, tipo: f.type }));
        if (!cd?._links?.next) break;
        cp++;
      }

      const amostra = [];
      for (const l of leads.slice(0, 5)) {
        const cRef = (l._embedded?.contacts || []).find((x) => x.is_main) || (l._embedded?.contacts || [])[0];
        let camposContato = null, contatoId = null;
        if (cRef) {
          contatoId = cRef.id;
          const cr = await fetch(`${api}/contacts/${cRef.id}`, { headers: auth });
          if (cr.ok) {
            const c = await cr.json().catch(() => ({}));
            camposContato = (c.custom_fields_values || []).map((f) => ({
              nome: f.field_name, code: f.field_code, valor: f.values?.[0]?.value,
            }));
          }
        }
        amostra.push({
          leadId: l.id,
          leadNome: l.name,
          contatoId,
          camposDoLead: (l.custom_fields_values || []).map((f) => ({
            id: f.field_id, nome: f.field_name, valor: f.values?.[0]?.value,
          })),
          camposDoContato: camposContato,
        });
      }
      return res.status(200).json({ ...base, camposDeLeadDaConta: catalogo, amostra });
    }

    // 2) Agrega + monta a lista detalhada por lead
    const porHora = {};
    const porDia = {};
    const categorias = { Quente: 0, Morno: 0, Outro: 0 };
    const porBairro = {};
    const porConsultor = {};
    let respondidos = 0, somaNps = 0, autorizados = 0;
    const lista = [];

    // cache de contatos já lidos (um contato pode servir a mais de um lead)
    const contatoCache = {};
    async function lerContato(cid) {
      if (contatoCache[cid] !== undefined) return contatoCache[cid];
      const cr = await fetch(`${api}/contacts/${cid}`, { headers: auth });
      if (!cr.ok) { contatoCache[cid] = null; return null; }
      const c = await cr.json().catch(() => ({}));
      contatoCache[cid] = c;
      return c;
    }

    const leadsProc = leads.slice(0, 500); // trava de segurança
    for (const l of leadsProc) {
      // horário (Manaus UTC-4)
      const ts = (l.created_at || 0) * 1000;
      const d = new Date(ts - 4 * 3600 * 1000);
      const hh = d.getUTCHours();
      const mm = d.getUTCMinutes();
      const hk = String(hh).padStart(2, "0");
      porHora[hk] = (porHora[hk] || 0) + 1;
      const horaLabel = `${hk}:${String(mm).padStart(2, "0")}`;

      // dia da captação (evento de vários dias) — vem do created_at do Kommo,
      // então leads antigos já ficam datados corretamente, sem retrabalho
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const diaLabel = `${dd}/${mo}`;
      const diaISO = `${d.getUTCFullYear()}-${mo}-${dd}`;
      porDia[diaISO] = (porDia[diaISO] || 0) + 1;

      // categoria
      const catEnum = getCFEnum(l, FIELD.categoria);
      let categoria = "—";
      if (catEnum === CAT_QUENTE) { categorias.Quente++; categoria = "Quente"; }
      else if (catEnum) { categorias.Morno++; categoria = "Morno"; }
      else categorias.Outro++;

      // bairro + filho
      const bairro = (getCF(l, FIELD.bairro) || "—").trim() || "—";
      porBairro[bairro] = (porBairro[bairro] || 0) + 1;
      const filho = getCF(l, FIELD.filho) || "—";

      // telefone + nome do responsável (do contato principal)
      const contatoRef = (l._embedded?.contacts || []).find((x) => x.is_main) || (l._embedded?.contacts || [])[0];
      let telefone = "—", responsavel = "—", nps = null, comentario = "", autoriza = false, deuFeedback = false;
      if (contatoRef) {
        const c = await lerContato(contatoRef.id);
        if (c) {
          responsavel = c.name || "—";
          const cfs = c.custom_fields_values || [];
          const byName = (nome) => cfs.find((f) => (f.field_name || "").toLowerCase() === nome);
          const byCode = (code) => cfs.find((f) => f.field_code === code);
          const tel = byCode("PHONE");
          if (tel) telefone = tel.values?.[0]?.value || "—";
          const npsF = byName("nps");
          const depoF = byName("depoimento");
          const autF = byName("autoriza uso do depoimento");
          if (npsF && npsF.values?.[0]?.value != null) { nps = Number(npsF.values[0].value); deuFeedback = true; }
          if (depoF && depoF.values?.[0]?.value) { comentario = String(depoF.values[0].value); deuFeedback = true; }
          if (autF && autF.values?.[0]?.value === true) autoriza = true;
          if (deuFeedback) {
            respondidos++;
            if (nps != null) somaNps += nps;
            if (autoriza) autorizados++;
          }
        }
      }

      // consultor e filho(s): estão na nota "CAPTAÇÃO EM EVENTO"
      // (o filho vem do campo do lead; se vier vazio, cai pra nota)
      let consultor = "—";
      let filhoNota = "";
      const nr = await fetch(`${api}/leads/${l.id}/notes?limit=50`, { headers: auth });
      if (nr.ok) {
        const nd = await nr.json().catch(() => ({}));
        for (const n of (nd?._embedded?.notes || [])) {
          const txt = n.params?.text || "";
          if (consultor === "—") {
            const m = txt.match(/Consultor:\s*(.+)/i);
            if (m) consultor = m[1].split("\n")[0].trim() || "—";
          }
          if (!filhoNota) {
            const f = txt.match(/Aluno\(s\):\s*(.+)/i) || txt.match(/Aluno:\s*(.+)/i);
            if (f) {
              const v = f[1].split("\n")[0].trim();
              if (v && v !== "-") filhoNota = v;
            }
          }
          if (consultor !== "—" && filhoNota) break;
        }
      }
      const filhoFinal = (filho && filho !== "—") ? filho : (filhoNota || "—");
      porConsultor[consultor] = (porConsultor[consultor] || 0) + 1;

      lista.push({
        id: l.id,
        hora: horaLabel,
        dia: diaLabel,
        diaISO,
        responsavel,
        filho: filhoFinal,
        telefone,
        bairro,
        categoria,
        consultor,
        deuFeedback,
        nps,
        comentario,
        autoriza,
      });
    }
    const npsMedio = respondidos ? (somaNps / respondidos) : 0;

    // ordena a lista por horário (mais recente primeiro)
    lista.sort((a, b) => (b.id || 0) - (a.id || 0));

    return res.status(200).json({
      ok: true,
      evento: eventoTag,
      total: leads.length,
      porHora,
      porDia,
      categorias,
      porConsultor,
      porBairro,
      feedback: {
        respondidos,
        npsMedio: Math.round(npsMedio * 10) / 10,
        autorizados,
        taxaResposta: leads.length ? Math.round((respondidos / leads.length) * 100) : 0,
      },
      lista,
    });
  } catch (err) {
    console.error("relatorio erro:", err);
    return res.status(500).json({ error: String(err) });
  }
}
