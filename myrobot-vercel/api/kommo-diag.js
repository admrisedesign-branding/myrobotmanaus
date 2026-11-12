// TEMPORÁRIO — diagnóstico do Kommo, SÓ LEITURA.
//
// Serve para descobrir se dá para desligar a integração de WhatsApp / o
// Salesbot pela API, usando o token que já vive aqui no servidor. Não escreve
// nada e não devolve o token. Apagar assim que a dúvida for respondida.
//
// Protegido por um segredo na query: sem ele, 404, para não virar porta aberta.

export default async function handler(req, res) {
  // o segredo não fica no código: só o sha256 dele
  const { createHash } = await import("node:crypto");
  const ok = createHash("sha256").update(String(req.query.k || "")).digest("hex")
    === "d6a1fe03c37b4e4255633b3cfdd933b63a7137a3dd9a16619df49064a75418fe";
  if (!ok) return res.status(404).end();
  const token = process.env.KOMMO_TOKEN;
  const sub = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
  if (!token) return res.status(200).json({ erro: "sem KOMMO_TOKEN" });

  const base = `https://${sub}.kommo.com/api/v4`;
  async function ler(caminho) {
    try {
      const r = await fetch(base + caminho, { headers: { Authorization: `Bearer ${token}` } });
      const txt = await r.text();
      let dados = null; try { dados = JSON.parse(txt); } catch { dados = txt.slice(0, 300); }
      return { status: r.status, dados };
    } catch (e) { return { erro: String(e && e.message) }; }
  }

  const conta   = await ler("/account");
  const wid     = await ler("/widgets/amocrm_whatsapp");
  const pipes   = await ler("/leads/pipelines");
  const fontes  = await ler("/sources?limit=250");
  const agora = Math.floor(Date.now() / 1000);
  const d7  = await ler(`/leads?filter[pipeline_id]=13965588&filter[created_at][from]=${agora - 7 * 86400}&limit=1`);
  const d30 = await ler(`/leads?filter[pipeline_id]=13965588&filter[created_at][from]=${agora - 30 * 86400}&limit=1`);
  const ultimos = await ler("/leads?filter[pipeline_id]=13965588&order[updated_at]=desc&limit=3");
  const widgets = await ler("/widgets?limit=250");
  const canais  = await ler("/chats/templates?limit=1");   // existe? diz se a API de chat responde

  const lista = (widgets.dados && widgets.dados._embedded && widgets.dados._embedded.widgets) || [];
  // o que vale é is_active_in_account: os 233 são o catálogo inteiro
  const ativos = lista.filter((w) => w.is_active_in_account === true);
  const porStatus = { ativos_na_conta: ativos.length, catalogo: lista.length };
  const interessantes = ativos;

  return res.status(200).json({
    conta: { status: conta.status, nome: conta.dados && conta.dados.name, id: conta.dados && conta.dados.id },
    widgets: {
      status: widgets.status,
      total: lista.length,
      porStatus,
      camposDoPrimeiro: lista[0] ? Object.keys(lista[0]) : [],
      ativos: interessantes.map((w) => ({ code: w.code, id: w.id, fonteDeLead: !!w.is_lead_source, pipeline: w.pipeline_id })).slice(0, 40),
    },
    api_de_chat: { status: canais.status },
    widget_detalhe: {
      status: wid.status,
      ativo: wid.dados && wid.dados.is_active_in_account,
      pipeline_id: wid.dados && wid.dados.pipeline_id,
      fonteDeLead: wid.dados && wid.dados.is_lead_source,
      chaves: wid.dados ? Object.keys(wid.dados) : [],
    },
    pipelines: {
      status: pipes.status,
      lista: (((pipes.dados || {})._embedded || {}).pipelines || [])
        .map((p2) => ({ id: p2.id, nome: p2.name, principal: !!p2.is_main, arquivado: !!p2.is_archive })),
    },
    movimento_no_funil: {
      criados_7d:  { status: d7.status,  total: d7.dados && d7.dados._page_count !== undefined ? undefined : undefined, bruto: d7.status === 204 ? 0 : ((((d7.dados||{})._embedded||{}).leads)||[]).length },
      criados_30d: { status: d30.status, bruto: d30.status === 204 ? 0 : ((((d30.dados||{})._embedded||{}).leads)||[]).length },
      mexidos_recentemente: ((((ultimos.dados||{})._embedded||{}).leads)||[]).map((l) => ({
        id: l.id, nome: l.name,
        criado: l.created_at ? new Date(l.created_at * 1000).toISOString().slice(0,10) : null,
        mexido: l.updated_at ? new Date(l.updated_at * 1000).toISOString().slice(0,10) : null })),
    },
    fontes_de_lead: {
      status: fontes.status,
      lista: (((fontes.dados || {})._embedded || {}).sources || [])
        .map((f) => ({ id: f.id, nome: f.name, pipeline: f.pipeline_id, servico: f.external_id || f.service })).slice(0, 30),
    },
  });
}
