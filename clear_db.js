const { HelpRequest, ShelterVolunteer } = require('./src/models');

async function clearOperationalData() {
  console.log('🚀 Iniciando limpeza do banco de dados...');
  try {
    // 1. Limpar Equipes (ShelterVolunteer) - Deve ser primeiro por causa da FK
    const deletedVolunteers = await ShelterVolunteer.destroy({ where: {}, truncate: false });
    console.log(`✅ Tabela de Equipes limpa!`);

    // 2. Limpar Solicitações (HelpRequest)
    // Filtramos apenas as de voluntariado se quiser ser específico, 
    // mas "limpar solicitações" geralmente cobre tudo.
    await HelpRequest.destroy({ where: {} });
    console.log(`✅ Tabela de Solicitações limpa!`);

    console.log('\n✨ Banco de dados limpo com sucesso! Pronto para novos testes.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro ao limpar o banco:', error);
    process.exit(1);
  }
}

clearOperationalData();
