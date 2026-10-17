// Seleção de vários dias de férias/folga: regras e prévia da meta.
// Funções puras (sem DOM), usadas pelo index.html e pelos testes (node --test).
(function (g) {
  'use strict';
  const FDS = ['sabado', 'domingo'];
  const ehFds = (d) => d.dia_semana ? FDS.includes(d.dia_semana) : [0, 6].includes(new Date(d.dia + 'T12:00:00Z').getUTCDay());
  // Dia útil na conta do /resumo: não é fim de semana, feriado nem ausência
  const ehUtil = (d) => !ehFds(d) && !('feriado' in d) && !d.ausencia;

  // Pode entrar na seleção? Devolve null se sim, ou o motivo se não.
  function motivoBloqueio(d) {
    if (!d) return 'dia fora do mês';
    if (ehFds(d)) return 'fim de semana não conta na meta';
    if ('feriado' in d) return 'já é feriado';
    if (d.status === 'presencial') return 'já tem presença registrada (apague o registro antes)';
    return null; // dias com ausência entram para trocar o tipo (férias <-> folga)
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
    const necessarios = Math.ceil(uteis * meta - 1e-9);
    const restantes = dias.filter((d) => ehUtil(d) && d.dia >= hoje && d.status !== 'presencial' && !tira.has(d.dia)).length;
    const faltam = Math.max(0, necessarios - feitos);
    return {
      ...r, dias_uteis: uteis, dias_presenciais: feitos, dias_necessarios: necessarios, faltam,
      percentual: uteis ? Math.round(1000 * feitos / uteis) / 10 : 0, da_pra_bater: faltam <= restantes,
      tirados: novos.length,
    };
  }

  // Grava um dia por vez (a API só aceita um dia por chamada). O upsert é idempotente,
  // então repetir um dia que falhou é seguro. Para em 401/429 (token/bloqueio):
  // os dias seguintes nem são tentados e voltam como pendentes.
  async function registrar(call, dias, tipo) {
    const ok = [], falhas = [];
    const lista = [...new Set(dias)].sort();
    for (let i = 0; i < lista.length; i++) {
      const dia = lista[i];
      try {
        await call('/ausencia', { method: 'POST', body: JSON.stringify({ dia, tipo }) });
        ok.push(dia);
      } catch (e) {
        falhas.push({ dia, erro: e });
        if (e === 401 || e === 429) { for (const d of lista.slice(i + 1)) falhas.push({ dia: d, erro: 'não tentado' }); break; }
      }
    }
    return { ok, falhas };
  }

  // Só Férias e Folga usam a seleção de vários dias; os outros tipos seguem um dia por vez.
  const usaVariosDias = (acao) => acao === 'ferias' || acao === 'folga';

  const api = { usaVariosDias, ehFds, ehUtil, motivoBloqueio, previa, registrar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.Multidias = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
