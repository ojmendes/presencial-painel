// Seleção de vários dias de férias/folga, prévia da meta e meses anteriores.
// Funções puras (sem DOM), usadas pelo index.html e pelos testes (node --test).
(function (g) {
  'use strict';
  const FDS = ['sabado', 'domingo'];
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  // Quantos meses para trás o histórico alcança, sem contar o mês atual.
  const HISTORICO_MESES = 11;
  const ehFds = (d) => d.dia_semana ? FDS.includes(d.dia_semana) : [0, 6].includes(new Date(d.dia + 'T12:00:00Z').getUTCDay());
  // Dia útil na conta do /resumo: não é fim de semana, feriado nem ausência
  const ehUtil = (d) => !ehFds(d) && !('feriado' in d) && !d.ausencia;

  // Pode entrar na seleção de férias/folga? Devolve null se sim, ou o motivo se não.
  function motivoBloqueio(d) {
    if (!d) return 'dia fora do mês';
    if (ehFds(d)) return 'fim de semana não conta na meta';
    if ('feriado' in d) return 'já é feriado';
    if (d.status === 'presencial') return 'já tem presença registrada (apague o registro antes)';
    return null; // dias com ausência entram para trocar o tipo (férias <-> folga)
  }

  // Pode entrar na seleção de apagar? Só marca de férias ou folga. O registro de
  // presença (check-in/check-out) não impede: ele continua no dia.
  function motivoBloqueioApagar(d) {
    if (!d) return 'dia fora do mês';
    if (d.ausencia !== 'ferias' && d.ausencia !== 'folga') return 'não está marcado como férias nem folga';
    return null;
  }

  function conta(uteis, feitos, meta, extraRestante) {
    const necessarios = Math.ceil(uteis * meta - 1e-9);
    const faltam = Math.max(0, necessarios - feitos);
    const restantes = extraRestante();
    return {
      dias_uteis: uteis, dias_presenciais: feitos, dias_necessarios: necessarios, faltam,
      percentual: uteis ? Math.round(1000 * feitos / uteis) / 10 : 0,
      da_pra_bater: faltam <= restantes,
    };
  }

  // Recalcula o /resumo do mês como se os dias selecionados já fossem ausência.
  // r: resposta do /resumo; dias: lista do /dias (mesmo mês); sel: Iterable de 'AAAA-MM-DD'.
  function previa(r, dias, sel) {
    const meta = (r.meta_percentual ?? 60) / 100, hoje = r.hoje;
    const porDia = new Map(dias.map((d) => [d.dia, d]));
    const novos = [...new Set(sel)].filter((k) => porDia.has(k) && !motivoBloqueio(porDia.get(k)) && ehUtil(porDia.get(k)));
    const tira = new Set(novos);
    const uteis = r.dias_uteis - novos.length;
    const feitos = r.dias_presenciais; // dias presenciais não podem ser selecionados
    const base = conta(uteis, feitos, meta, () =>
      dias.filter((d) => ehUtil(d) && d.dia >= hoje && d.status !== 'presencial' && !tira.has(d.dia)).length);
    return { ...r, ...base, tirados: novos.length };
  }

  // Recalcula o /resumo como se as marcas de férias/folga selecionadas já tivessem
  // sido apagadas. Check-in/check-out não mudam: se o dia já era presencial, volta
  // a contar; senão volta a remoto/pendente/futuro.
  function previaApagar(r, dias, sel) {
    const meta = (r.meta_percentual ?? 60) / 100, hoje = r.hoje;
    const porDia = new Map(dias.map((d) => [d.dia, d]));
    const novos = [...new Set(sel)].filter((k) => porDia.has(k) && !motivoBloqueioApagar(porDia.get(k)));
    const tira = new Set(novos);
    let uteis = r.dias_uteis, feitos = r.dias_presenciais;
    for (const k of novos) {
      const d = porDia.get(k);
      if (ehFds(d) || ('feriado' in d)) continue;
      uteis++;
      if (d.status === 'presencial') feitos++;
    }
    const base = conta(uteis, feitos, meta, () => dias.filter((d) => {
      const util = !ehFds(d) && !('feriado' in d) && (!d.ausencia || tira.has(d.dia));
      return util && d.dia >= hoje && d.status !== 'presencial';
    }).length);
    return { ...r, ...base, tirados: novos.length };
  }

  // Mesma conta do /resumo, a partir do payload de /dias. O mês corrente continua
  // vindo de /resumo; meses anteriores usam isto (a API não recebe o mês no resumo).
  // `status === 'presencial'` já aplica o mínimo de horas do servidor.
  function resumoMes(dias, hoje, metaPercentual) {
    const metaPct = metaPercentual ?? 60;
    const lista = [...dias];
    const ym = lista.length ? lista[0].dia.slice(0, 7) : hoje.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const inicio = ym + '-01';
    const fim = ym + '-' + String(ultimo).padStart(2, '0');
    const uteisLista = lista.filter(ehUtil);
    const feitos = uteisLista.filter((d) => d.status === 'presencial').length;
    const meta = metaPct / 100;
    const base = conta(uteisLista.length, feitos, meta, () =>
      uteisLista.filter((d) => d.dia >= hoje && d.status !== 'presencial').length);
    const pendentes_checkout = lista
      .filter((d) => d.dia < hoje && (d.registros || []).some((reg) => !reg.saida && reg.origem !== 'ajuste'))
      .map((d) => d.dia)
      .sort();
    return { periodo: 'mes', inicio, fim, hoje, meta_percentual: metaPct, pendentes_checkout, ...base };
  }

  // Grava ou apaga um dia por vez (a API só aceita um dia por chamada).
  // O upsert/delete é idempotente o bastante para repetir um dia que falhou.
  // Para em 401/429 (token/bloqueio): os dias seguintes nem são tentados.
  async function umAum(call, dias, pedido) {
    const ok = [], falhas = [];
    const lista = [...new Set(dias)].sort();
    for (let i = 0; i < lista.length; i++) {
      const dia = lista[i];
      try {
        await pedido(dia);
        ok.push(dia);
      } catch (e) {
        falhas.push({ dia, erro: e });
        if (e === 401 || e === 429) { for (const d of lista.slice(i + 1)) falhas.push({ dia: d, erro: 'não tentado' }); break; }
      }
    }
    return { ok, falhas };
  }

  function registrar(call, dias, tipo) {
    return umAum(call, dias, (dia) => call('/ausencia', { method: 'POST', body: JSON.stringify({ dia, tipo }) }));
  }

  // Apaga só a linha de ausência. Não chama /registros nem /ajuste.
  function apagar(call, dias) {
    return umAum(call, dias, (dia) => call('/ausencias/' + dia, { method: 'DELETE' }));
  }

  function textoApagar(tipos) {
    const set = new Set(tipos);
    const n = tipos.length;
    const destes = n === 1 ? 'deste dia' : 'destes ' + n + ' dias';
    if (set.size === 1 && set.has('ferias')) return n === 1 ? 'Apagar estas férias?' : 'Apagar as férias ' + destes + '?';
    if (set.size === 1 && set.has('folga')) return n === 1 ? 'Apagar esta folga?' : 'Apagar as folgas ' + destes + '?';
    return 'Apagar férias e folgas ' + destes + '?';
  }

  // Só Férias, Folga e Apagar usam a seleção de vários dias.
  const usaVariosDias = (acao) => acao === 'ferias' || acao === 'folga' || acao === 'apagar';

  function somarMeses(ym, delta) {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) throw new Error('mês inválido');
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
  }

  // ym pode ser visto? Do mês de `hoje` até HISTORICO_MESES atrás. Nunca o futuro.
  function mesPermitido(ym, hoje, maxVolta = HISTORICO_MESES) {
    if (!/^\d{4}-\d{2}$/.test(ym) || !/^\d{4}-\d{2}-\d{2}$/.test(hoje)) return false;
    const atual = hoje.slice(0, 7);
    return ym >= somarMeses(atual, -maxVolta) && ym <= atual;
  }

  function nomeMes(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return ym;
    return MESES[Number(m[2]) - 1] + ' de ' + m[1];
  }

  const api = {
    usaVariosDias, ehFds, ehUtil, motivoBloqueio, motivoBloqueioApagar, previa, previaApagar,
    resumoMes, registrar, apagar, textoApagar, somarMeses, mesPermitido, nomeMes, HISTORICO_MESES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.Multidias = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
