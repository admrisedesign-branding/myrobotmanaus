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
  const widgets = await ler("/widgets?limit=250");
  const canais  = await ler("/chats/templates?limit=1");   // existe? diz se a API de chat responde

  // resume o que interessa, sem despejar a conta inteira
  const lista = (widgets.dados && widgets.dados._embedded && widgets.dados._embedded.widgets) || [];
  return res.status(200).json({
    conta: { status: conta.status, nome: conta.dados && conta.dados.name, id: conta.dados && conta.dados.id },
    widgets: {
      status: widgets.status,
      total: lista.length,
      instalados: lista.filter((w) => w.is_active || (w.settings_template && w.status === "installed"))
        .map((w) => ({ code: w.code, status: w.status, ativo: !!w.is_active })).slice(0, 40),
    },
    api_de_chat: { status: canais.status },
  });
}
