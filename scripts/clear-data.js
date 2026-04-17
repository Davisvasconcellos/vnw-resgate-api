const { HelpRequest, ShelterVolunteer, sequelize } = require('../src/models');

async function clearData() {
  try {
    console.log('--- INICIANDO LIMPEZA DE DADOS (POSTGRES) ---');

    // No Postgres, usamos TRUNCATE com CASCADE para limpar tabelas com relacionamentos
    await sequelize.query('TRUNCATE TABLE help_requests RESTART IDENTITY CASCADE;');
    console.log('✅ Tabela help_requests limpa (CASCADE).');

    await sequelize.query('TRUNCATE TABLE shelter_volunteers RESTART IDENTITY CASCADE;');
    console.log('✅ Tabela shelter_volunteers limpa (CASCADE).');

    console.log('--- BANCO DE DADOS LIMPO COM SUCESSO ---');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro ao limpar dados:', error);
    process.exit(1);
  }
}

clearData();
