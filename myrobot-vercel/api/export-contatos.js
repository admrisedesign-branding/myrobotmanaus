// api/export-contatos.js
// ⚠️ ARQUIVO TEMPORÁRIO — usar e APAGAR depois.
//
// Exporta contatos do CRM Kommo em CSV pronto para o Meta, podendo SEGMENTAR
// por etapa do funil (ex.: tirar os clientes já fechados, ou pegar só o
// "Remarketing"). O KOMMO_TOKEN fica no servidor.
//
// USO:
//   • Ver as colunas/contagens:  ...?key=myrobot2026&stats=1
//   • Baixar todos:              ...?key=myrobot2026
//   • Sem os fechados:           ...?key=myrobot2026&segmento=sem-fechados
//   • Só os fechados:            ...?key=myrobot2026&segmento=fechados
//   • Só a etapa "Remarketing":  ...?key=myrobot2026&segmento=remarketing
//   • Uma etapa específica:      ...?key=myrobot2026&etapa_id=NNN   (id vem do stats)
//
// Depois de baixar, APAGUE este arquivo do repo.

export const config = { maxDuration: 60 };

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const WON = 142; // status "Ganho/Fechado" (padrão do Kommo, em qualquer funil)

function normalizePhone(s) {
  if (!s) return "";
  let d = String(s).replace(/\D/g, "").replace(/^0+/, "");
  if (!d) return "";
  if (d.length >= 10 && d.length <= 11) d = "55" + d;
  return "+" + d;
}
function splitName(name) {
  const n = String(name || "").trim().replace(/\s+/g, " ");
  if (!n) return ["", ""];
  const p = n.split(" ");
  return [p.shift(), p.join(" ")];
}
function csv(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function pagedGet(url, headers, key) {
  // percorre páginas de um endpoint do Kommo e junta os itens de _embedded[key]
  const out = [];
  let page = 1;
  const MAX = 80;
  while (page <= MAX) {
    const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}limit=250&page=${page}`, { headers });
    if (r.status === 204) break;
    if (!r.ok) throw new Error(`Kommo ${r.status} em ${url} (página ${page})`);
    const data = await r.json().catch(() => ({}));
    const items = data?._embedded?.[key] || [];
    if (!items.length) break;
    out.push(...items);
    if (!data?._links?.next) break;
    page++;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.query.key !== "myrobot2026") return res.status(403).json({ error: "key inválida" });
  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: "KOMMO_TOKEN não está nas env vars da Vercel" });

  const auth = { Authorization: `Bearer ${token}` };
  const apiBase = `https://${SUBDOMAIN}.kommo.com/api/v4`;

  try {
    // 1) Mapa de etapas (status_id -> {funil, etapa})
    const pipes = await pagedGet(`${apiBase}/leads/pipelines`, auth, "pipelines");
    const etapaMap = {};
    for (const p of pipes) {
      for (const s of (p._embedded?.statuses || [])) {
        etapaMap[s.id] = { funil: p.name, etapa: s.name };
      }
    }
    const labelEtapa = (id) => etapaMap[id]?.etapa || (id === WON ? "Ganho/Fechado" : `etapa ${id}`);

    // 2) Todos os leads (com contatos vinculados e etapa)
    const leads = await pagedGet(`${apiBase}/leads?with=contacts`, auth, "leads");
    const statusPorContato = {}; // contactId -> Set(status_id)
    const leadsPorEtapa = {};    // status_id -> nº de leads
    for (const l of leads) {
      leadsPorEtapa[l.status_id] = (leadsPorEtapa[l.status_id] || 0) + 1;
      for (const c of (l._embedded?.contacts || [])) {
        (statusPorContato[c.id] = statusPorContato[c.id] || new Set()).add(l.status_id);
      }
    }

    // 3) Todos os contatos (com telefone/email)
    const contatos = await pagedGet(`${apiBase}/contacts`, auth, "contacts");

    // monta registros úteis (com telefone OU email)
    const registros = [];
    const vistos = new Set();
    for (const c of contatos) {
      const cfs = c.custom_fields_values || [];
      const phones = (cfs.find(f => f.field_code === "PHONE")?.values || []).map(v => normalizePhone(v.value)).filter(Boolean);
      const emails = (cfs.find(f => f.field_code === "EMAIL")?.values || []).map(v => String(v.value || "").trim().toLowerCase()).filter(Boolean);
      if (!phones.length && !emails.length) continue;
      const phone = phones[0] || "", email = emails[0] || "";
      const chave = phone + "|" + email;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const [fn, ln] = splitName(c.name);
      const statuses = [...(statusPorContato[c.id] || [])];
      const fechado = statuses.includes(WON);
      const temRemarketing = statuses.some(id => /remarketing/i.test(etapaMap[id]?.etapa || ""));
      const etapas = statuses.map(labelEtapa);
      registros.push({ email, phone, fn, ln, fechado, temRemarketing, etapas });
    }

    // 4) STATS — mostra as colunas e contagens
    if (req.query.stats === "1") {
      const porEtapa = Object.entries(leadsPorEtapa)
        .map(([id, n]) => ({ etapa_id: Number(id), funil: etapaMap[id]?.funil || "?", etapa: labelEtapa(Number(id)), leads: n }))
        .sort((a, b) => b.leads - a.leads);
      return res.status(200).json({
        ok: true,
        contatos_unicos_uteis: registros.length,
        fechados: registros.filter(r => r.fechado).length,
        sem_fechados: registros.filter(r => !r.fechado).length,
        em_remarketing: registros.filter(r => r.temRemarketing).length,
        por_etapa: porEtapa,
      });
    }

    // 5) Filtro por segmento
    let lista = registros;
    const seg = req.query.segmento;
    const etapaId = req.query.etapa_id ? Number(req.query.etapa_id) : null;
    if (etapaId) {
      lista = registros.filter(r => (statusPorContato && r.etapas) && r.etapas.includes(labelEtapa(etapaId)));
    } else if (seg === "sem-fechados") {
      lista = registros.filter(r => !r.fechado);
    } else if (seg === "fechados") {
      lista = registros.filter(r => r.fechado);
    } else if (seg === "remarketing") {
      lista = registros.filter(r => r.temRemarketing);
    }

    // 6) CSV pronto pro Meta
    const header = "email,phone,fn,ln,country";
    const rows = lista.map(r => [csv(r.email), csv(r.phone), csv(r.fn), csv(r.ln), "BR"].join(","));
    const conteudo = "\uFEFF" + [header, ...rows].join("\n");
    const hoje = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const sufixo = etapaId ? `etapa${etapaId}` : (seg || "todos");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="myrobot-meta-${sufixo}-${hoje}.csv"`);
    return res.status(200).send(conteudo);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
