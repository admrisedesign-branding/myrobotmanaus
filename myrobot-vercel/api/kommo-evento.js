// api/kommo-evento.js
// Recebe o formulário de captação de EVENTOS (tablet/celular dos consultores)
// e cria o lead direto no CRM Kommo, marcado como "Evento".
//
// Campos capturados no evento (enxuto, pra ser rápido no tablet):
//   • Nome do aluno        (fn)
//   • Idade                (fi)  -> o curso é derivado depois pela idade
//   • Responsável          (rn)
//   • Telefone             (wn)
//   • Bairro               (bairro)
//   • Consultor            (consultor) -> quem captou (vai pra nota + tag)
// Campos do evento (vêm embutidos no link, o consultor nem digita):
//   • Nome do evento       (evento)
//   • Local do evento      (local)
//   • Data do evento       (data)
//
// Grava o lead na etapa de entrada do funil Comercial 2026, com as tags
// "evento" + o nome do evento, registra o bairro e o filho nos campos, e
// adiciona uma NOTA legível com todos os dados do evento e do consultor.

const SUBDOMAIN   = process.env.KOMMO_SUBDOMAIN || "roboticanorte";
const PIPELINE_ID = 13965588;   // My Robot — Comercial 2026
const STATUS_ID   = 107779724;  // Etapa de entrada (Novo Lead)

const FIELD = {
  score:        3880739,  // numeric
  categoria:    3880741,  // select
  bairro:       3880749,
  origem:       3880751,
  filho:        3880753,
  comportamento:3881421,  // multiselect
};

// IDs das opções (do diagnóstico)
const CATEGORIA = { Quente: 4299211, Morno: 4299213, Frio: 4299215 };
const COMPORT_EVENTO = 4299859; // "Participou de evento"

// Bairros nobres (público quente). Comparação sem acento/maiúscula, por "contém".
const BAIRROS_NOBRES = [
  "adrianopolis", "ponta negra", "gracas", "vieiralves", "nossa senhora",
  "parque 10", "parque dez", "flores", "aleixo", "chapada", "dom pedro",
  "morada do sol", "conjunto morada", "sao francisco",
];
function semAcento(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function ehBairroNobre(bairro) {
  const b = semAcento(bairro);
  if (!b) return false;
  return BAIRROS_NOBRES.some((n) => b.includes(n));
}

// O ID fixo do campo "Filho" pode não bater com o da conta (ou o campo pode ter
// sido recriado). Aqui a gente descobre o ID pelo NOME uma vez e guarda em cache.
let FILHO_ID_CACHE = null;
async function idDoCampoFilho(token) {
  if (FILHO_ID_CACHE !== null) return FILHO_ID_CACHE;
  FILHO_ID_CACHE = FIELD.filho; // fallback
  try {
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const alvos = ["filho", "filho(a)", "filhos", "aluno", "aluno(a)", "nome do filho", "nome do aluno"];
    for (let p = 1; p <= 10; p++) {
      const r = await fetch(
        `https://${SUBDOMAIN}.kommo.com/api/v4/leads/custom_fields?limit=250&page=${p}`,
        { headers: auth }
      );
      if (r.status === 204 || !r.ok) break;
      const d = await r.json().catch(() => ({}));
      const cfs = d?._embedded?.custom_fields || [];
      if (!cfs.length) break;
      const achou = cfs.find(
        (f) => f.type === "text" && alvos.includes(String(f.name || "").trim().toLowerCase())
      );
      if (achou) { FILHO_ID_CACHE = achou.id; break; }
      if (!d?._links?.next) break;
    }
  } catch (e) { /* mantém o fallback */ }
  return FILHO_ID_CACHE;
}

function txt(id, value) {
  if (!id || value == null || String(value).trim() === "") return null;
  return { field_id: id, values: [{ value: String(value) }] };
}
function selectField(id, enumId) {
  if (!id || !enumId) return null;
  return { field_id: id, values: [{ enum_id: enumId }] };
}
function multiselectField(id, enumIds) {
  if (!id || !enumIds || !enumIds.length) return null;
  return { field_id: id, values: enumIds.map((e) => ({ enum_id: e })) };
}
function normalizePhone(s) {
  if (!s) return "";
  let d = String(s).replace(/\D/g, "");
  if (d.length >= 10 && d.length <= 11) d = "55" + d; // BR local → +55
  return d ? "+" + d : "";
}

export default async function handler(req, res) {
  // CORS liberado (formulário é público, rodando no tablet dos consultores)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.KOMMO_TOKEN;
  if (!token && String(process.env.KOMMO_ATIVO ?? "1") !== "0") {
    return res.status(500).json({ error: "KOMMO_TOKEN não configurado na Vercel" });
  }

  // ---- MODO DIAGNÓSTICO: GET ?diag=myrobot2026 lista os campos de lead e as opções ----
  if (req.method === "GET") {
    if ((req.query.diag || "") !== "myrobot2026") {
      return res.status(403).json({ error: "diag key inválida" });
    }
    try {
      const r = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/leads/custom_fields?limit=250`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json().catch(() => ({}));
      const campos = (data?._embedded?.custom_fields || []).map((f) => ({
        id: f.id,
        nome: f.name,
        tipo: f.type,
        opcoes: (f.enums || []).map((e) => ({ id: e.id, valor: e.value })),
      }));
      return res.status(200).json({ ok: true, campos });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const b = req.body || {};

    // Filhos: aceita a lista nova (b.filhos) e continua aceitando o par antigo (b.fn/b.fi).
    const listaFilhos = Array.isArray(b.filhos) && b.filhos.length
      ? b.filhos
      : [{ nome: b.fn, idade: b.fi }];
    const fmtFilho = (f) => {
      const n = String(f?.nome || "").trim();
      const id = String(f?.idade || "").replace(/\D/g, "");
      return [n, id ? `${id} anos` : ""].filter(Boolean).join(" — ");
    };
    const filhosTxt = listaFilhos.map(fmtFilho).filter(Boolean);
    const filho = filhosTxt.join(" · ");
    const idade = String(listaFilhos[0]?.idade || "").replace(/\D/g, "");
    const primeiroNome = String(listaFilhos[0]?.nome || "").trim();
    const evento = b.evento || "Evento";

    // ---- Qualificação automática ----
    // Bairro nobre => Quente (score 70). Fora da lista => Morno (score 50).
    const nobre = ehBairroNobre(b.bairro);
    const catId = nobre ? CATEGORIA.Quente : CATEGORIA.Morno;
    const score = nobre ? 70 : 50;

    // Campos do lead
    const leadFields = [
      txt(FIELD.score, score),
      selectField(FIELD.categoria, catId),
      multiselectField(FIELD.comportamento, [COMPORT_EVENTO]),
      txt(FIELD.bairro, b.bairro),
      txt(FIELD.origem, "evento"),   // origem padronizada = evento
      txt(await idDoCampoFilho(token), filho),
    ].filter(Boolean);

    // Contato
    const contactFields = [];
    const phone = normalizePhone(b.wn);
    if (phone) contactFields.push({ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] });

    // Tags: evento + nome do evento + categoria (pra filtrar fácil)
    const tags = [{ name: "evento" }, { name: nobre ? "Quente" : "Morno" }];
    if (b.evento) tags.push({ name: String(b.evento).slice(0, 40) });

    const payload = [{
      name: `Evento — ${primeiroNome || "aluno(a)"}${listaFilhos.length > 1 ? ` +${listaFilhos.length - 1}` : ""} (${b.rn || "responsável"})`,
      pipeline_id: PIPELINE_ID,
      status_id: STATUS_ID,
      custom_fields_values: leadFields,
      _embedded: {
        contacts: [{ name: b.rn || primeiroNome || "Lead de evento", custom_fields_values: contactFields }],
        tags,
      },
    }];

    // KOMMO_ATIVO=0 desliga o Kommo de vez (decisão de 16/11: a escola saiu dele).
    // O lead passa a existir só no Capta; nada aqui depende mais da resposta dele.
    const usarKommo = String(process.env.KOMMO_ATIVO ?? "1") !== "0";
    const r = usarKommo
      ? await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/leads/complex`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : { ok: false, status: 0, json: async () => ({}) };
    const data = await r.json().catch(() => ({}));
    // O Kommo NÃO pode derrubar a captação. Em 16/11 a assinatura venceu e ele
    // passou a responder 402: como a gravação dele vinha primeiro e abortava a
    // requisição, o lead não ia pro Kommo NEM pro Capta — sumia, e a família
    // não recebia nada. Agora a falha dele é registrada e o fluxo segue: quem
    // guarda o lead de verdade é o Capta.
    let kommoErro = null;
    if (!r.ok && usarKommo) {
      kommoErro = { status: r.status, detalhe: data?.detail || data?.title || null };
      console.error("Kommo erro:", r.status, JSON.stringify(data));
    }

    // Pega o lead_id criado pra anexar a nota do evento
    const leadId = r.ok ? (data?._embedded?.leads?.[0]?.id || data?.[0]?.id) : null;
    let notaOk = false;
    if (leadId) {
      const linhas = [
        "CAPTAÇÃO EM EVENTO",
        `Evento: ${b.evento || "-"}`,
        `Local: ${b.local || "-"}`,
        `Data: ${b.data || "-"}`,
        `Consultor: ${b.consultor || "-"}`,
        "",
        `Aluno(s): ${filho || "-"}`,
        `Idade: ${idade ? idade + " anos" : "-"}`,
        `Responsável: ${b.rn || "-"}`,
        `Telefone: ${b.wn || "-"}`,
        `Bairro: ${b.bairro || "-"}`,
        `Categoria: ${nobre ? "Quente" : "Morno"} (score ${score})`,
        "",
        "Isca entregue: voucher R$ 150",
      ].join("\n");
      const nr = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ note_type: "common", params: { text: linhas } }]),
      });
      notaOk = nr.ok;
    }

    // ---- grava também no Capta (não bloqueia o cadastro se falhar) ----
    let capta = null;
    try { capta = await gravarNoCapta(b, leadId); } catch (e) { console.error("Capta:", e.message); }

    const salvou = !!(capta && capta.ok) || !!leadId;
    return res.status(salvou ? 200 : 502).json({
      ok: salvou,
      feito: { lead: !!leadId, nota: notaOk, capta: !!(capta && capta.ok) },
      lead_id: leadId,
      kommo_erro: kommoErro,
      boas_vindas: (capta && capta.boas_vindas) || null,
      corrigido: (capta && capta.corrigido) || null,
      error: salvou ? undefined : "Não consegui salvar o lead em nenhum sistema",
    });
  } catch (err) {
    console.error("Falha geral:", err);
    return res.status(500).json({ error: String(err) });
  }
}


// ---------------------------------------------------------------------
// Mensagem de boas-vindas — montada AQUI, no servidor, para sair pelo
// WhatsApp oficial da escola (via Capta). A versão do navegador continua
// existindo como plano B manual; as duas precisam dizer a mesma coisa.
// ---------------------------------------------------------------------
function montarBoasVindas(dados) {
  const primeiro = String(dados.rn || "").trim().split(" ")[0];
  const filhos = Array.isArray(dados.filhos) && dados.filhos.length
    ? dados.filhos
    : [{ nome: dados.fn, idade: dados.fi }];
  const nomes = filhos.map(f => String(f?.nome || "").trim().split(" ")[0]).filter(Boolean);

  let alunoRef, verbo, cada = "";
  if (!nomes.length)            { alunoRef = "Seu filho(a)"; verbo = "saiu"; }
  else if (nomes.length === 1)  { alunoRef = nomes[0]; verbo = "saiu"; }
  else {
    alunoRef = nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
    verbo = "saíram"; cada = " cada";
  }

  const voucher = String(dados.voucher || "150").replace(/\D/g, "") || "150";
  const localFrase = dados.local_frase
    || ("no " + String(dados.local || "nosso evento").split(/\s[-\u2013\u2014]\s/)[0].trim());

  // Três mensagens seguidas em vez de um balão só: primeiro o obrigado,
  // depois o voucher aparecendo, e só então o que fazer com ele. O pedido de
  // feedback saiu daqui — vai à noite, quando a família já está em casa.
  return [
    { texto: "Oi, " + (primeiro || "") + "! 🧡 Aqui é a My Robot Manaus.\n\nQue bom ter recebido vocês hoje " + localFrase + "!" },
    { url: process.env.EVENTO_VOUCHER_IMG || null },
    { texto: alunoRef + " " + verbo + " daqui com um voucher de R$ " + voucher + cada +
             " de desconto na matrícula 🤖\n\nNosso time te chama pra explicar direitinho como usar." },
  ].filter(p => p.texto || p.url);
}

// Fallback: balão único (comportamento anterior), caso o Capta ainda não
// entenda a sequência. Aqui o pedido de feedback vai junto, porque nessa
// versão o disparo da noite não existe.
function montarBoasVindasUnica(dados) {
  const textos = montarBoasVindas(dados).filter(p => p.texto).map(p => p.texto);
  return textos.join("\n\n")
    + "\n\nE se sobrar 1 minutinho, conta pra gente como foi a experiência de vocês?\n"
    + linkFeedback(dados);
}

// Pedido de feedback: mandado à noite pelo Capta, não na hora da captação.
function linkFeedback(dados) {
  let tel = String(dados.wn || "").replace(/\D/g, "");
  if (tel.length >= 10 && tel.length <= 11) tel = "55" + tel;
  return "https://www.myrobotmanaus.com/feedback-evento.html?evento="
    + encodeURIComponent(dados.evento || "") + "&wn=" + tel;
}

function montarFeedback(dados) {
  const primeiro = String(dados.rn || "").trim().split(" ")[0];
  return "Oi" + (primeiro ? ", " + primeiro : "") + "! 🧡 Passando só pra saber como foi a experiência de vocês com a gente hoje.\n\nLeva 1 minutinho e ajuda demais:\n" + linkFeedback(dados);
}

// ---------------------------------------------------------------------
// Gravação dupla no Capta: o lead de evento entra no funil da escola já
// ligado ao evento certo, sem depender do espelho do Kommo.
// Variáveis: CAPTA_URL (opcional) · CAPTA_SLUG · CAPTA_TOKEN · CAPTA_EVENTO (opcional)
// ---------------------------------------------------------------------
async function gravarNoCapta(dados, kommoLeadId) {
  const base  = process.env.CAPTA_URL  || "https://capta.riseagencia.com";
  const slug  = process.env.CAPTA_SLUG || "my-robot-manaus";
  const token = process.env.CAPTA_TOKEN;
  if (!token) return null;                       // não configurado: segue a vida

  const filhos = Array.isArray(dados.filhos) ? dados.filhos : [];
  const primeiro = filhos[0] || {};
  const corpo = {
    slug, token,
    nome: (dados.rn || "").trim() || primeiro.nome || "Lead de evento",
    contato: String(dados.wn || "").replace(/\D/g, ""),
    origem: "evento",
    extra: {
      fonte: "evento", porta: "evento",
      crianca: primeiro.nome || null,
      idade: primeiro.idade ? Number(primeiro.idade) : null,
      atendente: dados.consultor || null,
      evento_nome: dados.evento || null,
      evento_local: dados.local || null,
      evento_data: dados.data || null,
      evento_id: process.env.CAPTA_EVENTO || null,
      // O Capta envia pelo número oficial da escola. Mandamos os DOIS formatos:
      // a versão nova lê `boas_vindas_partes` (3 mensagens + feedback à noite);
      // uma versão antiga ignora isso e cai no balão único com a imagem — que
      // é o comportamento de hoje. Assim a ordem dos deploys não importa.
      boas_vindas_partes: montarBoasVindas(dados),
      feedback_texto: montarFeedback(dados),
      boas_vindas: montarBoasVindasUnica(dados),
      boas_vindas_imagem: process.env.EVENTO_VOUCHER_IMG || null,
      kommo_lead_id: kommoLeadId || null,
      notas: [
        dados.bairro ? `Bairro: ${dados.bairro}` : null,
        filhos.length > 1 ? `Irmãos: ${filhos.map(f => `${f.nome}${f.idade ? " (" + f.idade + ")" : ""}`).join(", ")}` : null,
        dados.evento ? `Captado em ${dados.evento}${dados.local ? " · " + dados.local : ""}` : null,
      ].filter(Boolean).join(" · ") || null,
    },
  };
  // LGPD: o capta-ingest grava uma linha por finalidade em capta_consentimentos
  if (dados.consentimento && dados.consentimento.contato) {
    corpo.consentimento = {
      contato: true,
      dados_crianca: !!dados.consentimento.dados_crianca,
      marketing: !!dados.consentimento.marketing,
      responsavel: !!dados.consentimento.responsavel,
      versao: String(dados.consentimento.versao || "evento-v1"),
      texto: String(dados.consentimento.texto || "").slice(0, 1000),
      canal: "evento",
      registrado_por: dados.consultor || null,
    };
  }
  const r = await fetch(`${base}/api/capta-ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, ...j } : { ok: false, erro: j.error || r.status };
}
