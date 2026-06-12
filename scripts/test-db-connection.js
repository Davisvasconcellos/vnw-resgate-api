require('dotenv').config();

const { sequelize } = require('../src/config/database');

async function main() {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    throw new Error('Defina DATABASE_URL ou as variaveis DB_HOST/DB_NAME/DB_USER/DB_PASSWORD.');
  }

  await sequelize.authenticate();
  console.log('Database connection OK.');
}

main()
  .catch((error) => {
    console.error('Database connection failed.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      // Ignore close errors because the main failure has already been reported.
    }
  });
