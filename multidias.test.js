const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./multidias.js');

const SEM = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const dia = (iso, extra = {}) => {
  const wd = new Date(iso + 'T12:00:00Z').getUTCDay();
  return { dia: iso, dia_semana: SEM[wd], status: 'remoto', registros: [], ...extra };
};

test('histórico: 11 meses atrás, nunca o futuro', () => {
  const hoje = '2026-11-12';
  assert.equal(M.HISTORICO_MESES, 11);
  assert.equal(M.somarMeses('2026-11', -11), '2025-12');
  assert.equal(M.somarMeses('2026-01', -1), '2025-12');
  assert.equal(M.somarMeses('2025-12', 1), '2026-01');
  assert.equal(M.mesPermitido('2026-11', hoje), true);
  assert.equal(M.mesPermitido('2025-12', hoje), true);
  assert.equal(M.mesPermitido('2025-11', hoje), false);
  assert.equal(M.mesPermitido('2026-12', hoje), false);
  assert.equal(M.mesPermitido('2026-13', hoje), false);
  assert.equal(M.nomeMes('2026-03'), 'março de 2026');
  assert.equal(M.nomeMes('2025-12'), 'dezembro de 2025');
});

test('apagar só libera dia com férias ou folga', () => {
  assert.equal(M.motivoBloqueioApagar(undefined), 'dia fora do mês');
  assert.equal(M.motivoBloqueioApagar(dia('2026-10-05')), 'não está marcado como férias nem folga');
  assert.equal(M.motivoBloqueioApagar(dia('2026-10-06', { status: 'presencial' })), 'não está marcado como férias nem folga');
  assert.equal(M.motivoBloqueioApagar(dia('2026-10-07', { ausencia: 'ferias', status: 'folga' })), null);
  assert.equal(M.motivoBloqueioApagar(dia('2026-10-08', { ausencia: 'folga', status: 'folga' })), null);
  // presença no mesmo dia não bloqueia a remoção da marca
  assert.equal(M.motivoBloqueioApagar(dia('2026-10-09', { ausencia: 'ferias', status: 'presencial' })), null);
  assert.equal(M.usaVariosDias('apagar'), true);
  assert.equal(M.usaVariosDias('ferias'), true);
  assert.equal(M.usaVariosDias('p1'), false);
});

test('prévia de apagar devolve o dia à conta e não mexe em quem já era presencial por engano de marca', () => {
  const hoje = '2026-10-06';
  const dias = [
    dia('2026-10-03', { status: 'fim_de_semana' }),
    dia('2026-10-04', { status: 'fim_de_semana' }),
    dia('2026-10-05', { status: 'pendente', registros: [{ id: 1, saida: null, origem: 'manual' }] }),
    dia('2026-10-06', { status: 'presencial', horas: 5 }),
    dia('2026-10-07', { ausencia: 'ferias', status: 'folga' }),
    dia('2026-10-08', { status: 'feriado', feriado: 'Padroeira' }),
    dia('2026-10-09', { status: 'futuro' }),
  ];
  const r = M.resumoMes(dias, hoje, 60);
  assert.equal(r.inicio, '2026-10-01');
  assert.equal(r.fim, '2026-10-31');
  assert.equal(r.dias_uteis, 3);
  assert.equal(r.dias_presenciais, 1);
  assert.equal(r.percentual, 33.3);
  assert.equal(r.dias_necessarios, 2);
  assert.equal(r.faltam, 1);
  assert.equal(r.da_pra_bater, true);
  assert.deepEqual(r.pendentes_checkout, ['2026-10-05']);

  const semFerias = M.previaApagar(r, dias, ['2026-10-07']);
  assert.equal(semFerias.tirados, 1);
  assert.equal(semFerias.dias_uteis, 4);
  assert.equal(semFerias.dias_presenciais, 1);
  assert.equal(semFerias.percentual, 25);
  assert.equal(semFerias.dias_necessarios, 3);
  assert.equal(semFerias.faltam, 2);

  const fds = dia('2026-10-03', { ausencia: 'folga', status: 'fim_de_semana' });
  const comFds = M.previaApagar(r, dias.concat(fds), ['2026-10-03']);
  assert.equal(comFds.dias_uteis, r.dias_uteis);
  assert.equal(comFds.dias_presenciais, r.dias_presenciais);
});

test('apagar férias de um dia que também teve presença passa a contar o presencial', () => {
  const d = dia('2026-10-13', {
    ausencia: 'ferias', status: 'presencial', horas: 6,
    registros: [{ id: 9, entrada: '2026-10-13T12:00:00Z', saida: '2026-10-13T18:00:00Z', origem: 'manual' }],
  });
  const r = { meta_percentual: 60, hoje: '2026-10-20', dias_uteis: 10, dias_presenciais: 4 };
  const p = M.previaApagar(r, [d], ['2026-10-13']);
  assert.equal(p.dias_uteis, 11);
  assert.equal(p.dias_presenciais, 5);
  assert.equal(p.percentual, Math.round(1000 * 5 / 11) / 10);
});

test('marcar férias continua tirando o dia útil e ignora quem já é presencial', () => {
  const dias = [
    dia('2026-10-06', { status: 'presencial' }),
    dia('2026-10-09', { status: 'futuro' }),
  ];
  const r = { meta_percentual: 60, hoje: '2026-10-06', dias_uteis: 3, dias_presenciais: 1 };
  const p = M.previa(r, dias, ['2026-10-09', '2026-10-06']);
  assert.deepEqual(p.tirados, 1);
  assert.equal(p.dias_uteis, 2);
  assert.equal(p.dias_presenciais, 1);
  assert.equal(p.percentual, 50);
});

test('apagar chama só DELETE /ausencias e para em 401', async () => {
  const seen = [];
  const call = async (p, o = {}) => {
    seen.push(p + ' ' + o.method);
    if (p.endsWith('2026-10-08')) throw 500;
    if (p.endsWith('2026-10-09')) throw 401;
  };
  const r = await M.apagar(call, ['2026-10-09', '2026-10-07', '2026-10-08', '2026-10-10']);
  assert.deepEqual(seen, [
    '/ausencias/2026-10-07 DELETE',
    '/ausencias/2026-10-08 DELETE',
    '/ausencias/2026-10-09 DELETE',
  ]);
  assert.deepEqual(r.ok, ['2026-10-07']);
  assert.deepEqual(r.falhas.map((f) => f.dia + ':' + f.erro), [
    '2026-10-08:500',
    '2026-10-09:401',
    '2026-10-10:não tentado',
  ]);
  assert.equal(seen.some((s) => s.includes('registros') || s.includes('ajuste')), false);
});

test('textos de confirmação', () => {
  assert.equal(M.textoApagar(['ferias']), 'Apagar estas férias?');
  assert.equal(M.textoApagar(['ferias', 'ferias']), 'Apagar as férias destes 2 dias?');
  assert.equal(M.textoApagar(['folga']), 'Apagar esta folga?');
  assert.equal(M.textoApagar(['folga', 'folga', 'folga']), 'Apagar as folgas destes 3 dias?');
  assert.equal(M.textoApagar(['ferias', 'folga']), 'Apagar férias e folgas destes 2 dias?');
});
