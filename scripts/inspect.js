const { HelpRequest, User } = require('../src/models');

async function inspect() {
  try {
    const requests = await HelpRequest.findAll({
      where: { type: 'volunteer' },
      include: [{ model: User, as: 'volunteer', attributes: ['name'] }]
    });

    console.log('--- INSPEÇÃO DE SOLICITAÇÕES ---');
    requests.forEach(r => {
      console.log(`ID: ${r.id_code} | Status: ${r.status} | Voluntário: ${r.volunteer ? r.volunteer.name : 'NULO'} | Msg: ${r.volunteer_message}`);
    });
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

inspect();
