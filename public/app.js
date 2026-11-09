// SchoolPass — painel de administração (sem dependências)
// Design system: design-system/schoolpass/MASTER.md + pages/painel.md
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ic = (nome) => `<svg class="ic" aria-hidden="true"><use href="#i-${nome}"/></svg>`;
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TIPOS = { aluno: 'Aluno', funcionario: 'Funcionário', visitante: 'Visitante' };
const CRED = { cartao: 'Cartão', biometria: 'Digital', qrcode: 'QR Code', facial: 'Facial' };
const RESULTADO = {
  passou: ['ok', 'Passou'], liberado: ['neutra', 'Liberado'], negado: ['erro', 'Negado'],
  desistiu: ['alerta', 'Não girou'], manual: ['alerta', 'Manual'],
};
const TITULOS = { aovivo: 'Ao vivo', pessoas: 'Pessoas', turmas: 'Turmas', catracas: 'Catracas', relatorios: 'Relatórios' };

const armazem = {
  ler(k) { try { return localStorage.getItem(k); } catch { return null; } },
  gravar(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
};

let token = armazem.ler('sp-token') || '';
let turmas = [];
let eventosHoje = [];
let filtroEventos = '';
let fonteAoVivo = null;
let ultimoSinal = 0;

// ------------------------------------------------------------------ tema
(function aplicarTema() {
  const t = armazem.ler('sp-tema');
  if (t) document.documentElement.dataset.theme = t;
})();
$('#tema').onclick = () => {
  const escuroAgora = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const novo = escuroAgora ? 'light' : 'dark';
  document.documentElement.dataset.theme = novo;
  armazem.gravar('sp-tema', novo);
};

// ------------------------------------------------------------------ utilidades
function aviso(msg, erro = false) {
  const el = $('#aviso');
  el.textContent = msg; el.hidden = false; el.classList.toggle('erro', erro);
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (el.hidden = true), erro ? 6000 : 3000);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    ...opcoes,
    headers: { authorization: `Bearer ${token}`, ...(opcoes.body ? { 'content-type': 'application/json' } : {}) },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (r.status === 401) { sair(); throw new Error('Sessão expirada. Entre novamente.'); }
  const dados = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const det = dados?.detalhes?.map?.((d) => d.message).join('; ');
    throw new Error(det || dados?.erro || `Erro ${r.status}`);
  }
  return dados;
}

/** Envolve uma ação: mostra carregamento no botão e erros no aviso. */
const tentar = (fn) => async function (...a) {
  const btn = a[0]?.currentTarget instanceof HTMLButtonElement ? a[0].currentTarget : null;
  if (btn) btn.setAttribute('aria-busy', 'true');
  try { await fn.apply(this, a); } catch (e) { aviso(e.message, true); } finally { btn?.removeAttribute('aria-busy'); }
};
const hoje = () => new Date().toLocaleDateString('sv-SE');
const comToken = (url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
const dataBr = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';

/** Abre um diálogo; resolve com os valores do formulário ou null se cancelar. */
function dialogo(titulo, corpo, { aoAbrir, salvar = 'Salvar', extraRodape = '' } = {}) {
  const d = $('#dialogo'), f = $('#dialogo-form');
  f.innerHTML = `<div class="dialogo-cab"><h2 id="dialogo-titulo">${titulo}</h2>
      <button value="cancelar" class="btn icone" formnovalidate aria-label="Fechar">${ic('x')}</button></div>
    ${corpo}
    <div class="rodape">${extraRodape}<button value="cancelar" class="btn secundario" formnovalidate>Cancelar</button>
      <button value="salvar" class="btn primario">${salvar}</button></div>`;
  d.returnValue = '';
  d.showModal();
  aoAbrir?.(f);
  (f.querySelector('[autofocus]') || f.querySelector('input:not([type=checkbox]), select'))?.focus();
  return new Promise((ok) => {
    d.onclose = () => ok(d.returnValue === 'salvar' ? Object.fromEntries(new FormData(f)) : null);
  });
}
const fecharDialogo = () => $('#dialogo').close();
const vazioLinha = (cols, txt) => `<tr><td colspan="${cols}" class="vazio-linha">${txt}</td></tr>`;

// ------------------------------------------------------------------ login e navegação
function sair() {
  token = ''; armazem.gravar('sp-token', null);
  fonteAoVivo?.close(); fonteAoVivo = null;
  $('#app').hidden = true; $('#login').hidden = false;
  $('#token').focus();
}

$('#form-login').onsubmit = async (e) => {
  e.preventDefault();
  const campo = $('#token'), erro = $('#erro-login'), btn = e.submitter;
  if (!campo.value) { erro.textContent = 'Informe o token.'; campo.setAttribute('aria-invalid', 'true'); return; }
  token = campo.value;
  btn?.setAttribute('aria-busy', 'true');
  try {
    await api('/api/status');
    armazem.gravar('sp-token', token);
    erro.textContent = ''; campo.removeAttribute('aria-invalid'); campo.value = '';
    iniciar();
  } catch {
    erro.textContent = 'Token inválido.'; campo.setAttribute('aria-invalid', 'true');
  } finally { btn?.removeAttribute('aria-busy'); }
};
$('#sair').onclick = sair;
$('#sair-movel').onclick = sair;

function rotaAtual() {
  const h = location.hash.slice(1);
  return TITULOS[h] ? h : 'aovivo';
}
window.addEventListener('hashchange', () => { if (token) abrirAba(rotaAtual()); });

function abrirAba(nome) {
  $$('#abas a').forEach((a) => {
    if (a.dataset.aba === nome) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $$('[data-painel]').forEach((p) => (p.hidden = p.dataset.painel !== nome));
  $('#titulo-pagina').textContent = TITULOS[nome];
  document.title = `${TITULOS[nome]} · SchoolPass`;
  const carregar = { aovivo: carregarAoVivo, pessoas: carregarPessoas, turmas: carregarTurmas,
    catracas: carregarCatracas, relatorios: prepararRelatorios }[nome];
  tentar(carregar)();
}

async function iniciar() {
  $('#login').hidden = true; $('#app').hidden = false;
  turmas = await api('/api/turmas');
  abrirAba(rotaAtual());
  conectarAoVivo();
}

// ------------------------------------------------------------------ ao vivo
function linhaEvento(e) {
  const [cls, txt] = RESULTADO[e.resultado] || ['neutra', e.resultado];
  const origem = e.origem === 'facial' || e.origem === 'offline' ? ` <span class="etq neutra">${esc(e.origem)}</span>` : '';
  return `<td data-r="Hora" class="mono">${esc(e.ocorrido_em.slice(11, 16))}</td>
    <td data-r="Pessoa" class="nome">${e.pessoa_nome ? esc(e.pessoa_nome) : `<span class="suave mono">${esc(e.credencial_valor || '—')}</span>`}</td>
    <td data-r="Sentido">${e.sentido === 'entrada' ? 'Entrada' : e.sentido === 'saida' ? 'Saída' : '—'}</td>
    <td data-r="Resultado"><span class="etqs"><span class="etq ${cls}"><span class="ponto"></span>${txt}</span>${origem}</span></td>
    <td data-r="Catraca">${esc(e.catraca_nome || '')}</td>
    <td data-r="Motivo" class="suave pequeno">${esc(e.motivo || '')}</td>`;
}

function desenharEventos() {
  const lista = filtroEventos ? eventosHoje.filter((e) => e.resultado === filtroEventos) : eventosHoje;
  $('#lista-eventos').innerHTML = lista.slice(0, 300).map((e) => `<tr data-id="${e.id}">${linhaEvento(e)}</tr>`).join('') ||
    vazioLinha(6, filtroEventos ? 'Nenhuma passagem com esse filtro hoje.' : 'Nenhuma passagem hoje ainda.');
}

$$('[data-filtro]').forEach((b) => (b.onclick = () => {
  filtroEventos = b.dataset.filtro;
  $$('[data-filtro]').forEach((x) => { x.classList.toggle('ativo', x === b); x.setAttribute('aria-pressed', x === b); });
  desenharEventos();
}));

function desenharKpis(catracas) {
  const dentro = new Map();
  [...eventosHoje].reverse().forEach((e) => {
    if ((e.resultado === 'passou' || e.resultado === 'manual') && e.pessoa_id) dentro.set(e.pessoa_id, e.sentido === 'entrada');
  });
  const passou = eventosHoje.filter((e) => e.resultado === 'passou' || e.resultado === 'manual');
  const negados = eventosHoje.filter((e) => e.resultado === 'negado').length;
  const online = catracas ? catracas.filter((c) => c.conexao.conectada).length : null;
  const kpi = (rotulo, valor, cls = '') => `<div class="kpi ${cls}"><div class="rotulo">${rotulo}</div><div class="valor">${valor}</div></div>`;
  $('#kpis').innerHTML =
    kpi('Dentro agora', [...dentro.values()].filter(Boolean).length, 'destaque') +
    kpi('Entradas hoje', passou.filter((e) => e.sentido === 'entrada').length) +
    kpi('Saídas hoje', passou.filter((e) => e.sentido === 'saida').length) +
    kpi('Negados hoje', negados, negados ? 'alerta' : '') +
    (catracas ? kpi('Catracas online', `${online}/${catracas.length}`, online < catracas.length ? 'alerta' : '') : '');
  desenharKpis.ultimas = catracas ?? desenharKpis.ultimas;
}

async function carregarAoVivo() {
  const [status, eventos] = await Promise.all([api('/api/status'), api(`/api/eventos?data=${hoje()}&limite=1000`)]);
  eventosHoje = eventos;
  desenharCatracasStatus(status.catracas);
  desenharKpis(status.catracas);
  desenharEventos();
}

function desenharCatracasStatus(lista) {
  $('#status-catracas').innerHTML = lista.map((c) => {
    const on = c.conexao.conectada;
    return `<div class="cartao catraca-cartao">
      <div class="cab"><strong>${esc(c.nome)}</strong>
        <span class="etq ${on ? 'ok' : 'erro'}"><span class="ponto"></span>${on ? 'Conectada' : 'Desconectada'}</span></div>
      <div class="suave pequeno">Modo ${c.modo} · <span class="mono">${esc(c.ip)}:${c.porta}</span></div>
      <div class="acoes">
        <button class="btn secundario" data-liberar="${c.id}" data-sentido="entrada" ${on ? '' : 'disabled'}>${ic('entrar')}Liberar entrada</button>
        <button class="btn secundario" data-liberar="${c.id}" data-sentido="saida" ${on ? '' : 'disabled'}>${ic('sair')}Liberar saída</button>
      </div></div>`;
  }).join('') || `<div class="vazio">Nenhuma catraca cadastrada. <a href="#catracas">Cadastrar catraca</a></div>`;
  $$('[data-liberar]').forEach((b) => (b.onclick = tentar(() => liberar(b.dataset.liberar, b.dataset.sentido))));
}

async function liberar(catracaId, sentido) {
  const v = await dialogo(`Liberar ${sentido === 'entrada' ? 'entrada' : 'saída'}`, `
    <div class="campo"><label for="l-motivo">Motivo</label>
      <input id="l-motivo" name="motivo" required autofocus placeholder="Ex.: saída antecipada autorizada pela mãe">
      <p class="ajuda">Fica registrado no histórico.</p></div>
    <div class="campo"><label for="l-pessoa">Pessoa (opcional)</label>
      <select id="l-pessoa" name="pessoa_id"><option value="">Ninguém específico</option></select>
      <p class="ajuda">Se escolher um aluno, os responsáveis recebem o aviso.</p></div>`,
  { salvar: 'Liberar catraca', aoAbrir: async (f) => {
    const pessoas = await api('/api/pessoas');
    f.querySelector('select').insertAdjacentHTML('beforeend',
      pessoas.map((p) => `<option value="${p.id}">${esc(p.nome)}${p.turma_nome ? ` — ${esc(p.turma_nome)}` : ''}</option>`).join(''));
  } });
  if (!v) return;
  await api(`/api/catracas/${catracaId}/liberar`, { method: 'POST',
    body: { sentido, motivo: v.motivo, pessoa_id: v.pessoa_id ? Number(v.pessoa_id) : null } });
  aviso('Catraca liberada.');
}

// indicador de conexão ao vivo
function atualizarSinal() {
  const el = $('#sinal'), txt = $('.sinal-txt', el);
  if (!fonteAoVivo || fonteAoVivo.readyState === EventSource.CLOSED) { el.dataset.estado = 'off'; txt.textContent = 'Sem conexão'; return; }
  if (!ultimoSinal) { el.dataset.estado = ''; txt.textContent = 'Conectando…'; return; }
  const seg = Math.round((Date.now() - ultimoSinal) / 1000);
  const hora = new Date(ultimoSinal).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (seg > 60) { el.dataset.estado = 'velho'; txt.innerHTML = `Desatualizado<span class="hora"> · ${hora}</span>`; }
  else { el.dataset.estado = 'vivo'; txt.innerHTML = `Ao vivo<span class="hora"> · ${hora}</span>`; }
}
setInterval(atualizarSinal, 5000);

function conectarAoVivo() {
  fonteAoVivo?.close();
  const fonte = new EventSource(comToken('/api/eventos/ao-vivo'));
  fonteAoVivo = fonte;
  const marcar = () => { ultimoSinal = Date.now(); atualizarSinal(); };
  fonte.addEventListener('ping', marcar);
  fonte.addEventListener('evento', (m) => {
    marcar();
    const e = JSON.parse(m.data);
    // a mesma tentativa chega de novo quando muda de estado (liberado → passou/não girou)
    const i = eventosHoje.findIndex((x) => x.id === e.id);
    if (i >= 0) eventosHoje[i] = e; else eventosHoje.unshift(e);
    desenharKpis(desenharKpis.ultimas);
    const corpo = $('#lista-eventos');
    const existente = corpo.querySelector(`tr[data-id="${e.id}"]`);
    if (filtroEventos && e.resultado !== filtroEventos) { existente?.remove(); return; }
    if (existente) { existente.innerHTML = linhaEvento(e); return; }
    if (corpo.querySelector('.vazio-linha')) corpo.innerHTML = '';
    const tr = document.createElement('tr');
    tr.className = 'novo'; tr.dataset.id = e.id; tr.innerHTML = linhaEvento(e);
    corpo.prepend(tr);
  });
  fonte.addEventListener('status', () => { marcar(); if (rotaAtual() === 'aovivo') tentar(carregarAoVivo)(); });
  fonte.onerror = () => {
    atualizarSinal();
    if (fonte.readyState === EventSource.CLOSED) setTimeout(() => token && conectarAoVivo(), 5000);
  };
  atualizarSinal();
}

// ------------------------------------------------------------------ pessoas
async function carregarPessoas() {
  const q = new URLSearchParams({ busca: $('#busca-pessoa').value, tipo: $('#filtro-tipo').value });
  [...q.keys()].forEach((k) => !q.get(k) && q.delete(k));
  const lista = await api(`/api/pessoas?${q}`);
  $('#lista-pessoas').innerHTML = lista.map((p) => `<tr>
    <td data-r="Nome" class="nome">${esc(p.nome)}</td>
    <td data-r="Tipo">${TIPOS[p.tipo]}${p.acesso_livre ? ' <span class="etq neutra">livre</span>' : ''}</td>
    <td data-r="Matrícula" class="mono">${esc(p.matricula || '—')}</td>
    <td data-r="Turma">${esc(p.turma_nome || '—')}</td>
    <td data-r="Credenciais"><span class="etqs">${(p.credenciais || '').split(',').filter(Boolean).map((c) => `<span class="etq neutra">${CRED[c]}</span>`).join('') ||
      '<span class="etq alerta">Sem credencial</span>'}</span></td>
    <td class="acoes"><button class="btn secundario pequeno" data-editar="${p.id}">Abrir</button></td></tr>`).join('') ||
    vazioLinha(6, q.toString() ? 'Ninguém encontrado com essa busca.' : 'Nenhuma pessoa cadastrada ainda.');
  $$('[data-editar]').forEach((b) => (b.onclick = tentar(() => editarPessoa(Number(b.dataset.editar)))));
}
let tBusca;
$('#busca-pessoa').oninput = () => { clearTimeout(tBusca); tBusca = setTimeout(tentar(carregarPessoas), 300); };
$('#filtro-tipo').onchange = tentar(carregarPessoas);
$('#nova-pessoa').onclick = tentar(() => editarPessoa(null));

async function editarPessoa(id) {
  const p = id ? await api(`/api/pessoas/${id}`) : { tipo: 'aluno', ativo: 1, credenciais: [], responsaveis: [] };
  const opcoesTurma = turmas.map((t) => `<option value="${t.id}" ${p.turma_id === t.id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('');
  const corpo = `
    <div class="campos">
      <div class="campo"><label for="p-nome">Nome completo</label><input id="p-nome" name="nome" required value="${esc(p.nome)}"></div>
      <div class="campo"><label for="p-tipo">Tipo</label><select id="p-tipo" name="tipo">${Object.entries(TIPOS).map(([k, t]) =>
        `<option value="${k}" ${p.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="campo"><label for="p-mat">Matrícula</label><input id="p-mat" name="matricula" value="${esc(p.matricula)}"></div>
      <div class="campo"><label for="p-turma">Turma</label><select id="p-turma" name="turma_id"><option value="">Sem turma</option>${opcoesTurma}</select></div>
      <div class="campo"><label for="p-val">Válido até</label><input id="p-val" type="date" name="valido_ate" value="${esc(p.valido_ate)}">
        <p class="ajuda">Em branco = sem vencimento.</p></div>
    </div>
    <label class="marcar"><input type="checkbox" name="acesso_livre" ${p.acesso_livre ? 'checked' : ''}> Acesso livre (ignora horários da turma)</label>
    <label class="marcar"><input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''}> Cadastro ativo</label>
    ${id ? `
    <div class="bloco"><h3>Credenciais</h3>
      <ul class="lista">${p.credenciais.map((c) => `<li><span class="etqs"><span class="etq neutra">${CRED[c.tipo]}</span> <span class="mono">${esc(c.valor)}</span></span>
        <button type="button" class="btn icone" data-rem-cred="${c.id}" aria-label="Remover ${CRED[c.tipo]} ${esc(c.valor)}">${ic('lixo')}</button></li>`).join('') ||
        '<li class="vazio-item">Nenhuma credencial — esta pessoa não passa na catraca.</li>'}</ul>
      <div class="barra">
        <div class="campo inline"><label for="nc-tipo">Tipo</label><select id="nc-tipo">${Object.entries(CRED).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></div>
        <div class="campo inline cresce"><label for="nc-valor">Número / ID</label><input id="nc-valor" class="mono" placeholder="Ex.: 0012345678"></div>
        <button type="button" id="nc-add" class="btn secundario">${ic('mais')}Adicionar</button></div></div>
    <div class="bloco"><h3>Responsáveis <span class="suave pequeno">— recebem aviso de entrada e saída</span></h3>
      <ul class="lista">${p.responsaveis.map((r) => `<li><span>${esc(r.nome)} <span class="suave mono pequeno">${esc(r.telefone || r.email || '')}</span></span>
        <button type="button" class="btn icone" data-rem-resp="${r.id}" aria-label="Remover ${esc(r.nome)}">${ic('lixo')}</button></li>`).join('') ||
        '<li class="vazio-item">Nenhum responsável cadastrado.</li>'}</ul>
      <div class="barra">
        <div class="campo inline cresce"><label for="nr-nome">Nome</label><input id="nr-nome"></div>
        <div class="campo inline"><label for="nr-tel">WhatsApp</label><input id="nr-tel" class="mono" inputmode="tel" placeholder="+5592999998888"></div>
        <button type="button" id="nr-add" class="btn secundario">${ic('mais')}Adicionar</button></div></div>` :
    '<p class="suave pequeno">Depois de salvar você poderá adicionar cartões, digitais e responsáveis.</p>'}`;

  const v = await dialogo(id ? esc(p.nome) : 'Nova pessoa', corpo, {
    salvar: id ? 'Salvar' : 'Criar e continuar',
    extraRodape: id ? `<button type="button" class="btn fantasma esquerda" id="desativar">${ic('lixo')}Desativar</button>` : '',
    aoAbrir: (f) => {
      if (!id) return;
      const reabrir = () => { fecharDialogo(); editarPessoa(id); };
      $$('[data-rem-cred]', f).forEach((b) => (b.onclick = tentar(async () => { await api(`/api/credenciais/${b.dataset.remCred}`, { method: 'DELETE' }); reabrir(); })));
      $$('[data-rem-resp]', f).forEach((b) => (b.onclick = tentar(async () => { await api(`/api/responsaveis/${b.dataset.remResp}`, { method: 'DELETE' }); reabrir(); })));
      $('#nc-add', f).onclick = tentar(async () => {
        const valor = $('#nc-valor', f).value.trim();
        if (!valor) { $('#nc-valor', f).setAttribute('aria-invalid', 'true'); $('#nc-valor', f).focus(); return; }
        await api(`/api/pessoas/${id}/credenciais`, { method: 'POST', body: { tipo: $('#nc-tipo', f).value, valor } });
        reabrir();
      });
      $('#nr-add', f).onclick = tentar(async () => {
        const nome = $('#nr-nome', f).value.trim();
        if (!nome) { $('#nr-nome', f).setAttribute('aria-invalid', 'true'); $('#nr-nome', f).focus(); return; }
        await api(`/api/pessoas/${id}/responsaveis`, { method: 'POST', body: { nome, telefone: $('#nr-tel', f).value.trim() || null } });
        reabrir();
      });
      $('#desativar', f).onclick = tentar(async () => {
        if (!confirm('Desativar este cadastro? Ele deixa de passar na catraca, mas o histórico é mantido.')) return;
        await api(`/api/pessoas/${id}`, { method: 'DELETE' }); fecharDialogo(); aviso('Cadastro desativado.'); carregarPessoas();
      });
    },
  });
  if (!v) return;
  const dados = {
    nome: v.nome, tipo: v.tipo, matricula: v.matricula || null, turma_id: v.turma_id ? Number(v.turma_id) : null,
    valido_ate: v.valido_ate || null, acesso_livre: v.acesso_livre === 'on', ativo: v.ativo === 'on' || !id,
  };
  if (id) { await api(`/api/pessoas/${id}`, { method: 'PUT', body: dados }); aviso('Cadastro salvo.'); return carregarPessoas(); }
  const r = await api('/api/pessoas', { method: 'POST', body: dados });
  await carregarPessoas();
  return editarPessoa(r.id);
}

// ------------------------------------------------------------------ turmas e calendário
async function carregarTurmas() {
  turmas = await api('/api/turmas');
  const horarios = await Promise.all(turmas.map((t) => api(`/api/turmas/${t.id}/horarios`)));
  $('#lista-turmas').innerHTML = turmas.map((t, i) => `<div class="cartao turma-cartao">
    <div class="cab"><div><strong>${esc(t.nome)}</strong> ${t.turno ? `<span class="suave pequeno">· ${esc(t.turno)}</span>` : ''}</div>
      <span class="suave pequeno">${t.alunos} aluno(s)</span></div>
    ${horarios[i].length ? `<table class="horarios"><thead><tr><th></th><th>Entrada</th><th>Saída</th></tr></thead><tbody>
      ${horarios[i].map((h) => `<tr><td>${DIAS[h.dia_semana]}</td><td>${h.entrada_inicio}–${h.entrada_fim}</td><td>${h.saida_inicio}–${h.saida_fim}</td></tr>`).join('')}
      </tbody></table>` : '<p class="etq alerta">Sem horários — alunos desta turma não passam</p>'}
    <div><button class="btn secundario pequeno" data-turma="${t.id}">Editar horários</button></div></div>`).join('') ||
    '<div class="vazio">Nenhuma turma cadastrada.</div>';
  $$('[data-turma]').forEach((b) => (b.onclick = tentar(() => editarTurma(Number(b.dataset.turma)))));
  await carregarFeriados();
}
$('#nova-turma').onclick = tentar(() => editarTurma(null));

async function editarTurma(id) {
  const t = turmas.find((x) => x.id === id) || { nome: '', turno: '' };
  const hs = id ? await api(`/api/turmas/${id}/horarios`) : [];
  const porDia = Object.fromEntries(hs.map((h) => [h.dia_semana, h]));
  const padrao = { entrada_inicio: '06:30', entrada_fim: '07:30', saida_inicio: '11:30', saida_fim: '12:30' };
  const linha = (d) => {
    const h = porDia[d] || (id ? null : d >= 1 && d <= 5 ? padrao : null);
    const val = h || padrao;
    return `<tr class="${h ? '' : 'desligado'}"><td><label class="marcar"><input type="checkbox" name="d${d}" ${h ? 'checked' : ''} data-dia="${d}"> ${DIAS[d]}</label></td>
      ${['entrada_inicio', 'entrada_fim', 'saida_inicio', 'saida_fim'].map((c) =>
        `<td><input type="time" name="${c}${d}" value="${val[c]}" aria-label="${DIAS[d]} ${c.replace('_', ' ')}"></td>`).join('')}</tr>`;
  };
  const v = await dialogo(id ? `Turma ${esc(t.nome)}` : 'Nova turma', `
    <div class="campos">
      <div class="campo"><label for="t-nome">Nome</label><input id="t-nome" name="nome" required value="${esc(t.nome)}" placeholder="6º Ano A"></div>
      <div class="campo"><label for="t-turno">Turno</label><input id="t-turno" name="turno" value="${esc(t.turno)}" placeholder="Manhã"></div>
    </div>
    <div class="bloco"><h3>Janelas de acesso</h3>
      <p class="ajuda suave pequeno" style="margin:0">O aluno só passa sozinho dentro destas janelas. Fora delas, a catraca pede para procurar a secretaria.</p>
      <div style="overflow-x:auto"><table class="tabela-horarios"><thead><tr><th>Dia</th><th>Entra de</th><th>até</th><th>Sai de</th><th>até</th></tr></thead>
        <tbody>${[1, 2, 3, 4, 5, 6, 0].map(linha).join('')}</tbody></table></div></div>`, {
    extraRodape: id ? `<button type="button" class="btn fantasma esquerda" id="excluir-turma">${ic('lixo')}Excluir</button>` : '',
    aoAbrir: (f) => {
      $$('[data-dia]', f).forEach((c) => (c.onchange = () => c.closest('tr').classList.toggle('desligado', !c.checked)));
      if (id) $('#excluir-turma', f).onclick = tentar(async () => {
        if (!confirm('Excluir a turma? Os alunos ficam sem turma e não passam até serem movidos.')) return;
        await api(`/api/turmas/${id}`, { method: 'DELETE' }); fecharDialogo(); aviso('Turma excluída.'); carregarTurmas();
      });
    },
  });
  if (!v) return;
  const dados = { nome: v.nome, turno: v.turno || null, ativa: true };
  const lista = [0, 1, 2, 3, 4, 5, 6].filter((d) => v[`d${d}`]).map((d) => ({
    dia_semana: d, entrada_inicio: v[`entrada_inicio${d}`], entrada_fim: v[`entrada_fim${d}`],
    saida_inicio: v[`saida_inicio${d}`], saida_fim: v[`saida_fim${d}`],
  }));
  const tid = id ?? (await api('/api/turmas', { method: 'POST', body: dados })).id;
  if (id) await api(`/api/turmas/${id}`, { method: 'PUT', body: dados });
  await api(`/api/turmas/${tid}/horarios`, { method: 'PUT', body: lista });
  aviso('Turma salva.'); carregarTurmas();
}

async function carregarFeriados() {
  const lista = await api('/api/dias-sem-aula');
  $('#lista-feriados').innerHTML = lista.map((d) => `<li><span><span class="mono">${dataBr(d.data)}</span> ${esc(d.descricao || '')}</span>
    <button class="btn icone" data-rem-dia="${d.data}" aria-label="Remover ${dataBr(d.data)}">${ic('lixo')}</button></li>`).join('') ||
    '<li class="vazio-item">Nenhum dia cadastrado.</li>';
  $$('[data-rem-dia]').forEach((b) => (b.onclick = tentar(async () => { await api(`/api/dias-sem-aula/${b.dataset.remDia}`, { method: 'DELETE' }); carregarFeriados(); })));
}
$('#form-feriado').onsubmit = (e) => {
  e.preventDefault();
  tentar(async () => {
    const v = Object.fromEntries(new FormData(e.target));
    await api('/api/dias-sem-aula', { method: 'POST', body: { data: v.data, descricao: v.descricao || null } });
    e.target.reset(); aviso('Dia sem aula adicionado.'); carregarFeriados();
  })();
};

// ------------------------------------------------------------------ catracas
async function carregarCatracas() {
  const lista = await api('/api/catracas');
  $('#lista-catracas').innerHTML = lista.map((c) => `<tr>
    <td data-r="Nome" class="nome">${esc(c.nome)}</td>
    <td data-r="Endereço" class="mono">${esc(c.ip)}:${c.porta}</td>
    <td data-r="Modo">${c.modo === 'online' ? 'Online' : 'Offline'}${c.sentido_invertido ? ' <span class="etq neutra">invertida</span>' : ''}</td>
    <td data-r="Conexão"><span class="etq ${c.conexao.conectada ? 'ok' : 'erro'}"><span class="ponto"></span>${c.conexao.conectada ? 'Conectada' : esc(c.conexao.erro || 'Desconectada')}</span></td>
    <td class="acoes"><button class="btn secundario pequeno" data-relogio="${c.id}" ${c.conexao.conectada ? '' : 'disabled'}>${ic('relogio')}Acertar relógio</button>
      <button class="btn secundario pequeno" data-catraca="${c.id}">Editar</button></td></tr>`).join('') ||
    vazioLinha(5, 'Nenhuma catraca cadastrada.');
  $$('[data-catraca]').forEach((b) => (b.onclick = tentar(() => editarCatraca(lista.find((c) => c.id === Number(b.dataset.catraca))))));
  $$('[data-relogio]').forEach((b) => (b.onclick = tentar(async () => { await api(`/api/catracas/${b.dataset.relogio}/relogio`, { method: 'POST' }); aviso('Relógio da catraca acertado.'); })));
}
$('#nova-catraca').onclick = tentar(() => editarCatraca(null));
$('#baixar-lista').onclick = (e) => { e.preventDefault(); location.href = comToken('/api/offline/lista.csv'); };

async function editarCatraca(c) {
  c = c || { nome: '', ip: '', porta: 3000, modo: 'online', sentido_invertido: 0, ativa: 1 };
  const v = await dialogo(c.id ? `Catraca ${esc(c.nome)}` : 'Nova catraca', `
    <div class="campos">
      <div class="campo"><label for="c-nome">Nome</label><input id="c-nome" name="nome" required value="${esc(c.nome)}" placeholder="Portaria principal"></div>
      <div class="campo"><label for="c-ip">IP da catraca</label><input id="c-ip" name="ip" class="mono" required value="${esc(c.ip)}" placeholder="192.168.0.50" inputmode="decimal"></div>
      <div class="campo"><label for="c-porta">Porta</label><input id="c-porta" name="porta" class="mono" type="number" min="1" max="65535" required value="${c.porta}">
        <p class="ajuda">Padrão Henry: 3000</p></div>
      <div class="campo"><label for="c-modo">Modo</label><select id="c-modo" name="modo">
        <option value="online" ${c.modo === 'online' ? 'selected' : ''}>Online — SchoolPass decide</option>
        <option value="offline" ${c.modo === 'offline' ? 'selected' : ''}>Offline — catraca decide</option></select></div>
    </div>
    <label class="marcar"><input type="checkbox" name="sentido_invertido" ${c.sentido_invertido ? 'checked' : ''}> Instalada com sentido invertido (entrada e saída trocadas)</label>
    <label class="marcar"><input type="checkbox" name="ativa" ${c.ativa ? 'checked' : ''}> Ativa</label>`, {
    extraRodape: c.id ? `<button type="button" class="btn fantasma esquerda" id="excluir-catraca">${ic('lixo')}Excluir</button>` : '',
    aoAbrir: (f) => {
      if (c.id) $('#excluir-catraca', f).onclick = tentar(async () => {
        if (!confirm('Excluir esta catraca? O histórico de passagens é mantido.')) return;
        await api(`/api/catracas/${c.id}`, { method: 'DELETE' }); fecharDialogo(); aviso('Catraca excluída.'); carregarCatracas();
      });
    },
  });
  if (!v) return;
  const dados = { nome: v.nome, ip: v.ip.trim(), porta: Number(v.porta), modo: v.modo,
    sentido_invertido: v.sentido_invertido === 'on', ativa: v.ativa === 'on' || !c.id };
  await api(c.id ? `/api/catracas/${c.id}` : '/api/catracas', { method: c.id ? 'PUT' : 'POST', body: dados });
  aviso('Catraca salva.'); carregarCatracas();
}

// ------------------------------------------------------------------ relatórios
function prepararRelatorios() {
  if (!$('#rel-inicio').value) {
    const d = new Date(); $('#rel-fim').value = hoje();
    $('#rel-inicio').value = new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
  }
  const sel = $('#rel-turma').value;
  $('#rel-turma').innerHTML = '<option value="">Todas</option>' +
    turmas.map((t) => `<option value="${t.id}" ${String(t.id) === sel ? 'selected' : ''}>${esc(t.nome)}</option>`).join('');
  return gerarRelatorio();
}
function urlRelatorio(csv) {
  const ini = $('#rel-inicio').value, fim = $('#rel-fim').value, turma = $('#rel-turma').value;
  const base = ini === fim ? `/api/relatorios/dia?data=${ini}` : `/api/relatorios/periodo?inicio=${ini}&fim=${fim}`;
  return `${base}${turma ? `&turma=${turma}` : ''}${csv ? '&formato=csv' : ''}`;
}
async function gerarRelatorio() {
  if ($('#rel-inicio').value > $('#rel-fim').value) throw new Error('A data inicial é depois da final.');
  const dia = $('#rel-inicio').value === $('#rel-fim').value;
  const linhas = await api(urlRelatorio(false));
  const kpi = (r, v, cls = '') => `<div class="kpi ${cls}"><div class="rotulo">${r}</div><div class="valor">${v}</div></div>`;
  if (dia) {
    const pres = linhas.filter((l) => l.presente).length;
    $('#rel-resumo').innerHTML = kpi('Alunos', linhas.length) + kpi('Presentes', pres, 'destaque') + kpi('Ausentes', linhas.length - pres, linhas.length - pres ? 'alerta' : '');
  } else {
    const baixa = linhas.filter((l) => l.dias_letivos && l.percentual < 75).length;
    const media = linhas.length ? Math.round(linhas.reduce((s, l) => s + l.percentual, 0) / linhas.length * 10) / 10 : 0;
    $('#rel-resumo').innerHTML = kpi('Alunos', linhas.length) + kpi('Frequência média', `${media}%`, 'destaque') + kpi('Abaixo de 75%', baixa, baixa ? 'alerta' : '');
  }
  $('#rel-cabecalho').innerHTML = dia
    ? '<tr><th>Aluno</th><th>Turma</th><th>Entrada</th><th>Saída</th><th>Situação</th></tr>'
    : '<tr><th>Aluno</th><th>Turma</th><th>Dias letivos</th><th>Presenças</th><th>Frequência</th></tr>';
  $('#rel-corpo').innerHTML = linhas.map((l) => dia
    ? `<tr><td data-r="Aluno" class="nome">${esc(l.nome)}</td><td data-r="Turma">${esc(l.turma || '—')}</td>
       <td data-r="Entrada" class="mono">${l.entrada || '—'}</td><td data-r="Saída" class="mono">${l.saida || '—'}</td>
       <td data-r="Situação"><span class="etq ${l.presente ? 'ok' : 'erro'}"><span class="ponto"></span>${l.presente ? 'Presente' : 'Ausente'}</span></td></tr>`
    : `<tr><td data-r="Aluno" class="nome">${esc(l.nome)}</td><td data-r="Turma">${esc(l.turma || '—')}</td>
       <td data-r="Dias letivos" class="mono">${l.dias_letivos}</td><td data-r="Presenças" class="mono">${l.dias_presente}</td>
       <td data-r="Frequência"><span class="etq ${l.percentual >= 75 ? 'ok' : 'alerta'}">${l.percentual}%</span></td></tr>`).join('') ||
    vazioLinha(5, 'Nenhum aluno para os filtros escolhidos.');
  $('#rel-legenda').textContent = dia ? 'Presente = ao menos uma passagem registrada no dia.'
    : 'Dias letivos contam os dias com horário da turma, descontando os dias sem aula. Abaixo de 75% aparece em amarelo.';
}
$('#form-rel').onsubmit = (e) => { e.preventDefault(); tentar(gerarRelatorio)(); };
$('#rel-csv').onclick = (e) => { e.preventDefault(); location.href = comToken(urlRelatorio(true)); };

// ------------------------------------------------------------------ início
if (token) api('/api/status').then(iniciar).catch(sair); else sair();
