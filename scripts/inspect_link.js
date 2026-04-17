const { HelpRequest, Shelter, User } = require('../src/models');

async function inspectLink() {
  try {
    const shelters = await Shelter.findAll({ attributes: ['id', 'id_code', 'name'] });
    console.log('--- ABRIGOS NO BANCO ---');
    shelters.forEach(s => console.log(`ID: ${s.id} | Code: ${s.id_code} | Nome: ${s.name}`));

    const requests = await HelpRequest.findAll({
      where: { type: 'volunteer' },
      attributes: ['id_code', 'status', 'shelter_id', 'user_id']
    });

    console.log('\n--- PEDIDOS DE VOLUNTÁRIOS ---');
    requests.forEach(r => {
      console.log(`Req: ${r.id_code} | Status: ${r.status} | ShelterID Link: ${r.shelter_id} | CreatedByUserID: ${r.user_id}`);
    });
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

inspectLink();
