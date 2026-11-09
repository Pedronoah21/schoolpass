// SchoolPass — painel de administração (sem dependências)
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TIPOS = { aluno: 'Aluno', funcionario: 'Funcionário', visitante: 'Visitante' };
const CRED = { cartao: 'Cartão', biometria: 'Digital', qrcode: 'QR Code', facial: 'Facial' };
const RESULTADO = {
  passou: ['ok', 'Passou'], liberado: ['neutra', 'Liberado'], negado: ['erro', 'Negado'],
  desistiu: ['alerta', 'Não girou'], manual: ['alerta', 'Manual'],
};

let token = '';
try { token = localStorage.getItem('sp-token') || ''; } catch { /* sem armazenamento */ }
let turmas = [];

// ------------------------------------------------------------------ utilidades
function aviso(msg) {
  const el = $('#aviso');
  el.textContent = msg; el.hidden = false;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (el.hidden = true), 3500);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    ...opcoes,
    headers: { authorization: `Bearer ${token}`, ...(opcoes.body ? { 'content-type': 'application/json' } : {}) },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (r.status === 401) { sair(); throw new Error('Sessão expirada'); }
  const dados = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const det = dados?.detalhes?.map?.((d) => `${d.path?.join('.')}: ${d.message}`).join('; ');
    throw new Error(det || dados?.erro || `Erro ${r.status}`);
  }
  return dados;
}

const tentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message); } };
const hoje = () => new Date().toLocaleDateString('sv-SE');
const comToken = (url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

/** Abre um diálogo com HTML de formulário; resolve com os valores ou null se cancelar. */
function dialogo(html, aoAbrir) {
  const d = $('#dialogo'), f = $('#dialogo-form');
  f.innerHTML = html;
  aoAbrir?.(f);
  d.showModal();
  return new Promise((ok) => {
    d.onclose = () => {
      if (d.returnValue !== 'salvar') return ok(null);
      ok(Object.fromEntries(new FormData(f)));
    };
    f.onsubmit = (e) => {
      if (e.submitter?.value === 'cancelar') return;
      if (!f.checkValidity()) { e.preventDefault(); f.reportValidity(); }
    };
  });
}
const rodape = (txt = 'Salvar') =>
  `<div class="rodape"><button value="cancelar" class="secundario" formnovalidate>Cancelar</button><button value="salvar">${txt}</button></div>`;

// ------------------------------------------------------------------ login e abas
function sair() {
  token = ''; try { localStorage.removeItem('sp-token'); } catch {}
  $('#app').hidden = true; $('#login').hidden = false;
}

$('#form-login').onsubmit = async (e) => {
  e.preventDefault();
  token = new FormData(e.target).get('token');
  try {
    await api('/api/status');
    try { localStorage.setItem('sp-token', token); } catch {}
    iniciar();
  } catch { $('#erro-login').textContent = 'Token inválido.'; }
};
$('#sair').onclick = sair;

$$('#abas button').forEach((b) => (b.onclick = () => abrirAba(b.dataset.aba)));
function abrirAba(nome) {
  $$('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
  $$('[data-painel]').forEach((p) => (p.hidden = p.dataset.painel !== nome));
  ({ aovivo: carregarAoVivo, pessoas: carregarPessoas, turmas: carregarTurmas,
     catracas: carregarCatracas, relatorios: prepararRelatorios, calendario: carregarFeriados })[nome]?.();
}

async function iniciar() {
  $('#login').hidden = true; $('#app').hidden = false;
  turmas = await api('/api/turmas');
  abrirAba('aovivo');
  conectarAoVivo();
}

// ------------------------------------------------------------------ ao vivo
function linhaEvento(e) {
  const [cls, txt] = RESULTADO[e.resultado] || ['neutra', e.resultado];
  return `<td>${esc(e.ocorrido_em.slice(11, 16))}</td><td>${esc(e.pessoa_nome || e.credencial_valor || '—')}</td>
    <td>${e.sentido === 'entrada' ? 'Entrada' : e.sentido === 'saida' ? 'Saída' : '—'}</td>
    <td><span class="etiqueta ${cls}">${txt}</span>${e.origem === 'facial' || e.origem === 'offline' ? ` <span class="sutil">${esc(e.origem)}</span>` : ''}</td>
    <td>${esc(e.catraca_nome || '')}</td><td class="sutil">${esc(e.motivo || '')}</td>`;
}

async function carregarAoVivo() {
  const [status, eventos] = await Promise.all([api('/api/status'), api(`/api/eventos?data=${hoje()}&limite=200`)]);
  desenharCatracasStatus(status.catracas);
  $('#lista-eventos').innerHTML = eventos.map((e) => `<tr>${linhaEvento(e)}</tr>`).join('') ||
    '<tr><td colspan="6" class="sutil">Nenhuma passagem hoje.</td></tr>';
  contar(eventos);
}

function contar(eventos) {
  const dentro = new Map();
  [...eventos].reverse().forEach((e) => {
    if ((e.resultado === 'passou' || e.resultado === 'manual') && e.pessoa_id) dentro.set(e.pessoa_id, e.sentido === 'entrada');
  });
  const n = [...dentro.values()].filter(Boolean).length;
  $('#contadores').textContent = `${n} pessoa(s) dentro agora · ${eventos.filter((e) => e.resultado === 'negado').length} negado(s)`;
}

function desenharCatracasStatus(lista) {
  $('#status-catracas').innerHTML = lista.map((c) => `
    <div class="cartao">
      <div class="topo"><strong>${esc(c.nome)}</strong>
        <span class="etiqueta ${c.conexao.conectada ? 'ok' : 'erro'}">${c.conexao.conectada ? 'Conectada' : 'Desconectada'}</span></div>
      <div class="sutil">Modo ${c.modo} · ${esc(c.ip)}:${c.porta}</div>
      <div class="acoes">
        <button data-liberar="${c.id}" data-sentido="entrada" ${c.conexao.conectada ? '' : 'disabled'}>Liberar entrada</button>
        <button data-liberar="${c.id}" data-sentido="saida" class="secundario" ${c.conexao.conectada ? '' : 'disabled'}>Liberar saída</button>
      </div>
    </div>`).join('') || '<p class="sutil">Nenhuma catraca cadastrada. Cadastre na aba Catracas.</p>';
  $$('[data-liberar]').forEach((b) => (b.onclick = tentar(() => liberar(b.dataset.liberar, b.dataset.sentido))));
}

async function liberar(catracaId, sentido) {
  const v = await dialogo(`<h2>Liberar ${sentido}</h2>
    <label>Motivo<input name="motivo" required placeholder="Ex.: saída antecipada autorizada"></label>
    <label>Pessoa (opcional — avisa os responsáveis)<select name="pessoa_id"><option value="">Ninguém específico</option></select></label>
    ${rodape('Liberar')}`, async (f) => {
      const pessoas = await api('/api/pessoas');
      f.querySelector('select').insertAdjacentHTML('beforeend',
        pessoas.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join(''));
    });
  if (!v) return;
  await api(`/api/catracas/${catracaId}/liberar`, { method: 'POST',
    body: { sentido, motivo: v.motivo, pessoa_id: v.pessoa_id ? Number(v.pessoa_id) : null } });
  aviso('Catraca liberada.');
}

function conectarAoVivo() {
  const fonte = new EventSource(comToken('/api/eventos/ao-vivo'));
  fonte.addEventListener('evento', (m) => {
    const e = JSON.parse(m.data);
    const corpo = $('#lista-eventos');
    if (corpo.querySelector('td[colspan]')) corpo.innerHTML = '';
    const tr = document.createElement('tr');
    tr.className = 'novo'; tr.innerHTML = linhaEvento(e);
    corpo.prepend(tr);
  });
  fonte.addEventListener('status', () => { if (!$('[data-painel=aovivo]').hidden) carregarAoVivo(); });
  fonte.onerror = () => { fonte.close(); setTimeout(() => token && conectarAoVivo(), 5000); };
}

// ------------------------------------------------------------------ pessoas
async function carregarPessoas() {
  const q = new URLSearchParams({ busca: $('#busca-pessoa').value, tipo: $('#filtro-tipo').value });
  [...q.keys()].forEach((k) => !q.get(k) && q.delete(k));
  const lista = await api(`/api/pessoas?${q}`);
  $('#lista-pessoas').innerHTML = lista.map((p) => `<tr>
    <td>${esc(p.nome)}</td><td>${TIPOS[p.tipo]}</td><td>${esc(p.matricula || '')}</td><td>${esc(p.turma_nome || '')}</td>
    <td>${(p.credenciais || '').split(',').filter(Boolean).map((c) => `<span class="etiqueta neutra">${CRED[c]}</span>`).join(' ')}</td>
    <td class="acoes"><button class="secundario" data-editar="${p.id}">Abrir</button></td></tr>`).join('') ||
    '<tr><td colspan="6" class="sutil">Nenhuma pessoa encontrada.</td></tr>';
  $$('[data-editar]').forEach((b) => (b.onclick = tentar(() => editarPessoa(Number(b.dataset.editar)))));
}
let tBusca;
$('#busca-pessoa').oninput = () => { clearTimeout(tBusca); tBusca = setTimeout(tentar(carregarPessoas), 300); };
$('#filtro-tipo').onchange = tentar(carregarPessoas);
$('#nova-pessoa').onclick = tentar(() => editarPessoa(null));

async function editarPessoa(id) {
  const p = id ? await api(`/api/pessoas/${id}`) : { tipo: 'aluno', ativo: 1, credenciais: [], responsaveis: [] };
  const opcoesTurma = turmas.map((t) => `<option value="${t.id}" ${p.turma_id === t.id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('');
  const v = await dialogo(`<h2>${id ? esc(p.nome) : 'Nova pessoa'}</h2>
    <div class="campos">
      <label>Nome<input name="nome" required value="${esc(p.nome)}"></label>
      <label>Tipo<select name="tipo">${Object.entries(TIPOS).map(([k, t]) => `<option value="${k}" ${p.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Matrícula<input name="matricula" value="${esc(p.matricula)}"></label>
      <label>Turma<select name="turma_id"><option value="">—</option>${opcoesTurma}</select></label>
      <label>Válido até<input type="date" name="valido_ate" value="${esc(p.valido_ate)}"></label>
    </div>
    <label class="linha"><input type="checkbox" name="acesso_livre" ${p.acesso_livre ? 'checked' : ''}> Acesso livre (ignora horário)</label>
    <label class="linha"><input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''}> Ativo</label>
    ${id ? `
      <h3>Credenciais</h3>
      <ul class="lista">${p.credenciais.map((c) => `<li><span><span class="etiqueta neutra">${CRED[c.tipo]}</span> ${esc(c.valor)}</span>
        <button type="button" class="link" data-rem-cred="${c.id}">Remover</button></li>`).join('') || '<li class="sutil">Nenhuma</li>'}</ul>
      <div class="barra"><select id="nc-tipo">${Object.entries(CRED).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select>
        <input id="nc-valor" placeholder="Número do cartão / ID"><button type="button" id="nc-add" class="secundario">Adicionar</button></div>
      <h3>Responsáveis (recebem aviso)</h3>
      <ul class="lista">${p.responsaveis.map((r) => `<li><span>${esc(r.nome)} <span class="sutil">${esc(r.telefone || r.email || '')}</span></span>
        <button type="button" class="link" data-rem-resp="${r.id}">Remover</button></li>`).join('') || '<li class="sutil">Nenhum</li>'}</ul>
      <div class="barra"><input id="nr-nome" placeholder="Nome"><input id="nr-tel" placeholder="+5592999998888">
        <button type="button" id="nr-add" class="secundario">Adicionar</button></div>
      <div><button type="button" class="perigo" id="desativar">Desativar cadastro</button></div>` :
      '<p class="sutil">Salve para adicionar credenciais e responsáveis.</p>'}
    ${rodape()}`, (f) => {
      if (!id) return;
      const reabrir = () => { $('#dialogo').close(); editarPessoa(id); };
      $$('[data-rem-cred]', f).forEach((b) => (b.onclick = tentar(async () => { await api(`/api/credenciais/${b.dataset.remCred}`, { method: 'DELETE' }); reabrir(); })));
      $$('[data-rem-resp]', f).forEach((b) => (b.onclick = tentar(async () => { await api(`/api/responsaveis/${b.dataset.remResp}`, { method: 'DELETE' }); reabrir(); })));
      $('#nc-add', f).onclick = tentar(async () => {
        await api(`/api/pessoas/${id}/credenciais`, { method: 'POST', body: { tipo: $('#nc-tipo', f).value, valor: $('#nc-valor', f).value } });
        reabrir();
      });
      $('#nr-add', f).onclick = tentar(async () => {
        await api(`/api/pessoas/${id}/responsaveis`, { method: 'POST', body: { nome: $('#nr-nome', f).value, telefone: $('#nr-tel', f).value || null } });
        reabrir();
      });
      $('#desativar', f).onclick = tentar(async () => {
        if (!confirm('Desativar este cadastro? O histórico de passagens é mantido.')) return;
        await api(`/api/pessoas/${id}`, { method: 'DELETE' }); $('#dialogo').close(); carregarPessoas();
      });
    });
  if (!v) return;
  const corpo = {
    nome: v.nome, tipo: v.tipo, matricula: v.matricula || null, turma_id: v.turma_id ? Number(v.turma_id) : null,
    valido_ate: v.valido_ate || null, acesso_livre: v.acesso_livre === 'on', ativo: v.ativo === 'on' || !id,
  };
  if (id) await api(`/api/pessoas/${id}`, { method: 'PUT', body: corpo });
  else { const r = await api('/api/pessoas', { method: 'POST', body: corpo }); await carregarPessoas(); return editarPessoa(r.id); }
  aviso('Salvo.'); carregarPessoas();
}

// ------------------------------------------------------------------ turmas
async function carregarTurmas() {
  turmas = await api('/api/turmas');
  const horarios = await Promise.all(turmas.map((t) => api(`/api/turmas/${t.id}/horarios`)));
  $('#lista-turmas').innerHTML = turmas.map((t, i) => `<div class="cartao">
    <div class="topo"><strong>${esc(t.nome)}</strong><span class="sutil">${t.alunos} aluno(s)</span></div>
    <table class="horarios">${horarios[i].map((h) => `<tr><td>${DIAS[h.dia_semana]}</td>
      <td>Entrada ${h.entrada_inicio}–${h.entrada_fim} · Saída ${h.saida_inicio}–${h.saida_fim}</td></tr>`).join('') ||
      '<tr><td colspan="2" class="sutil">Sem horários: alunos desta turma não passam.</td></tr>'}</table>
    <div class="acoes"><button class="secundario" data-turma="${t.id}">Editar</button></div></div>`).join('') ||
    '<p class="sutil">Nenhuma turma.</p>';
  $$('[data-turma]').forEach((b) => (b.onclick = tentar(() => editarTurma(Number(b.dataset.turma)))));
}
$('#nova-turma').onclick = tentar(() => editarTurma(null));

async function editarTurma(id) {
  const t = turmas.find((x) => x.id === id) || { nome: '', turno: '', ativa: 1 };
  const hs = id ? await api(`/api/turmas/${id}/horarios`) : [];
  const porDia = Object.fromEntries(hs.map((h) => [h.dia_semana, h]));
  const linha = (d) => {
    const h = porDia[d];
    return `<tr><td><label class="linha"><input type="checkbox" name="d${d}" ${h ? 'checked' : ''}> ${DIAS[d]}</label></td>
      ${['entrada_inicio', 'entrada_fim', 'saida_inicio', 'saida_fim'].map((c) =>
        `<td><input type="time" name="${c}${d}" value="${h ? h[c] : { entrada_inicio: '06:30', entrada_fim: '07:30', saida_inicio: '11:30', saida_fim: '12:30' }[c]}"></td>`).join('')}</tr>`;
  };
  const v = await dialogo(`<h2>${id ? 'Editar turma' : 'Nova turma'}</h2>
    <div class="campos"><label>Nome<input name="nome" required value="${esc(t.nome)}"></label>
      <label>Turno<input name="turno" value="${esc(t.turno)}"></label></div>
    <h3>Horários de acesso</h3>
    <table class="tabela-horarios"><tr class="sutil"><td></td><td>Entra de</td><td>até</td><td>Sai de</td><td>até</td></tr>
      ${[1, 2, 3, 4, 5, 6, 0].map(linha).join('')}</table>
    ${id ? '<div><button type="button" class="perigo" id="excluir-turma">Excluir turma</button></div>' : ''}
    ${rodape()}`, (f) => {
      if (id) $('#excluir-turma', f).onclick = tentar(async () => {
        if (!confirm('Excluir a turma? Os alunos ficam sem turma.')) return;
        await api(`/api/turmas/${id}`, { method: 'DELETE' }); $('#dialogo').close(); carregarTurmas();
      });
    });
  if (!v) return;
  const corpo = { nome: v.nome, turno: v.turno || null, ativa: true };
  const tid = id ?? (await api('/api/turmas', { method: 'POST', body: corpo })).id;
  if (id) await api(`/api/turmas/${id}`, { method: 'PUT', body: corpo });
  const lista = [0, 1, 2, 3, 4, 5, 6].filter((d) => v[`d${d}`]).map((d) => ({
    dia_semana: d, entrada_inicio: v[`entrada_inicio${d}`], entrada_fim: v[`entrada_fim${d}`],
    saida_inicio: v[`saida_inicio${d}`], saida_fim: v[`saida_fim${d}`],
  }));
  await api(`/api/turmas/${tid}/horarios`, { method: 'PUT', body: lista });
  aviso('Turma salva.'); carregarTurmas();
}

// ------------------------------------------------------------------ catracas
async function carregarCatracas() {
  const lista = await api('/api/catracas');
  $('#lista-catracas').innerHTML = lista.map((c) => `<tr>
    <td>${esc(c.nome)}</td><td>${esc(c.ip)}:${c.porta}</td>
    <td>${c.modo === 'online' ? 'Online' : 'Offline'}${c.sentido_invertido ? ' <span class="sutil">(sentido invertido)</span>' : ''}</td>
    <td><span class="etiqueta ${c.conexao.conectada ? 'ok' : 'erro'}">${c.conexao.conectada ? 'Conectada' : esc(c.conexao.erro || 'Desconectada')}</span></td>
    <td class="acoes"><button class="secundario" data-relogio="${c.id}">Acertar relógio</button>
      <button class="secundario" data-catraca="${c.id}">Editar</button></td></tr>`).join('') ||
    '<tr><td colspan="5" class="sutil">Nenhuma catraca.</td></tr>';
  $$('[data-catraca]').forEach((b) => (b.onclick = tentar(() => editarCatraca(lista.find((c) => c.id === Number(b.dataset.catraca))))));
  $$('[data-relogio]').forEach((b) => (b.onclick = tentar(async () => { await api(`/api/catracas/${b.dataset.relogio}/relogio`, { method: 'POST' }); aviso('Relógio enviado.'); })));
}
$('#nova-catraca').onclick = tentar(() => editarCatraca(null));
$('#baixar-lista').onclick = (e) => { e.preventDefault(); location.href = comToken('/api/offline/lista.csv'); };

async function editarCatraca(c) {
  c = c || { nome: '', ip: '', porta: 3000, modo: 'online', sentido_invertido: 0, ativa: 1 };
  const v = await dialogo(`<h2>${c.id ? 'Editar catraca' : 'Nova catraca'}</h2>
    <div class="campos">
      <label>Nome<input name="nome" required value="${esc(c.nome)}" placeholder="Portaria principal"></label>
      <label>IP da catraca<input name="ip" required value="${esc(c.ip)}" placeholder="192.168.0.50"></label>
      <label>Porta<input name="porta" type="number" required value="${c.porta}"></label>
      <label>Modo<select name="modo"><option value="online" ${c.modo === 'online' ? 'selected' : ''}>Online (SchoolPass decide)</option>
        <option value="offline" ${c.modo === 'offline' ? 'selected' : ''}>Offline (catraca decide)</option></select></label>
    </div>
    <label class="linha"><input type="checkbox" name="sentido_invertido" ${c.sentido_invertido ? 'checked' : ''}> Catraca instalada com sentido invertido</label>
    <label class="linha"><input type="checkbox" name="ativa" ${c.ativa ? 'checked' : ''}> Ativa</label>
    ${c.id ? '<div><button type="button" class="perigo" id="excluir-catraca">Excluir</button></div>' : ''}
    ${rodape()}`, (f) => {
      if (c.id) $('#excluir-catraca', f).onclick = tentar(async () => {
        if (!confirm('Excluir esta catraca?')) return;
        await api(`/api/catracas/${c.id}`, { method: 'DELETE' }); $('#dialogo').close(); carregarCatracas();
      });
    });
  if (!v) return;
  const corpo = { nome: v.nome, ip: v.ip, porta: Number(v.porta), modo: v.modo,
    sentido_invertido: v.sentido_invertido === 'on', ativa: v.ativa === 'on' || !c.id };
  await api(c.id ? `/api/catracas/${c.id}` : '/api/catracas', { method: c.id ? 'PUT' : 'POST', body: corpo });
  aviso('Catraca salva.'); carregarCatracas();
}

// ------------------------------------------------------------------ relatórios
function prepararRelatorios() {
  if (!$('#rel-inicio').value) {
    const d = new Date(); $('#rel-fim').value = hoje();
    $('#rel-inicio').value = new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
  }
  $('#rel-turma').innerHTML = '<option value="">Todas as turmas</option>' +
    turmas.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('');
  gerarRelatorio();
}
function urlRelatorio(csv) {
  const ini = $('#rel-inicio').value, fim = $('#rel-fim').value, turma = $('#rel-turma').value;
  const base = ini === fim ? `/api/relatorios/dia?data=${ini}` : `/api/relatorios/periodo?inicio=${ini}&fim=${fim}`;
  return `${base}${turma ? `&turma=${turma}` : ''}${csv ? '&formato=csv' : ''}`;
}
const gerarRelatorio = tentar(async () => {
  const dia = $('#rel-inicio').value === $('#rel-fim').value;
  const linhas = await api(urlRelatorio(false));
  $('#rel-cabecalho').innerHTML = dia
    ? '<tr><th>Aluno</th><th>Turma</th><th>Entrada</th><th>Saída</th><th>Situação</th></tr>'
    : '<tr><th>Aluno</th><th>Turma</th><th>Dias letivos</th><th>Presenças</th><th>Frequência</th></tr>';
  $('#rel-corpo').innerHTML = linhas.map((l) => dia
    ? `<tr><td>${esc(l.nome)}</td><td>${esc(l.turma)}</td><td>${l.entrada || '—'}</td><td>${l.saida || '—'}</td>
       <td><span class="etiqueta ${l.presente ? 'ok' : 'erro'}">${l.presente ? 'Presente' : 'Ausente'}</span></td></tr>`
    : `<tr><td>${esc(l.nome)}</td><td>${esc(l.turma)}</td><td>${l.dias_letivos}</td><td>${l.dias_presente}</td>
       <td><span class="etiqueta ${l.percentual >= 75 ? 'ok' : 'alerta'}">${l.percentual}%</span></td></tr>`).join('') ||
    '<tr><td colspan="5" class="sutil">Sem dados.</td></tr>';
  $('#rel-legenda').textContent = dia ? 'Presença = ao menos uma passagem registrada no dia.'
    : 'Dias letivos contam os dias com horário da turma, descontando o calendário de dias sem aula.';
});
$('#rel-gerar').onclick = gerarRelatorio;
$('#rel-csv').onclick = (e) => { e.preventDefault(); location.href = comToken(urlRelatorio(true)); };

// ------------------------------------------------------------------ calendário
async function carregarFeriados() {
  const lista = await api('/api/dias-sem-aula');
  $('#lista-feriados').innerHTML = lista.map((d) => `<li><span>${d.data.split('-').reverse().join('/')} ${esc(d.descricao || '')}</span>
    <button class="link" data-rem-dia="${d.data}">Remover</button></li>`).join('') || '<li class="sutil">Nenhum dia cadastrado.</li>';
  $$('[data-rem-dia]').forEach((b) => (b.onclick = tentar(async () => { await api(`/api/dias-sem-aula/${b.dataset.remDia}`, { method: 'DELETE' }); carregarFeriados(); })));
}
$('#form-feriado').onsubmit = tentar(async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  await api('/api/dias-sem-aula', { method: 'POST', body: { data: v.data, descricao: v.descricao || null } });
  e.target.reset(); carregarFeriados();
});

// ------------------------------------------------------------------ início
if (token) api('/api/status').then(iniciar).catch(sair); else sair();
