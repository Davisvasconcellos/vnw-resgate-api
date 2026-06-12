require('dotenv').config();

const { Client } = require('pg');
const { spawnSync } = require('child_process');

function parseBooleanEnv(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function getSslConfig(rawDatabaseUrl) {
  const explicit = parseBooleanEnv(process.env.DB_SSL);
  if (explicit !== undefined) {
    return explicit ? { rejectUnauthorized: false } : false;
  }

  if (!rawDatabaseUrl) {
    return false;
  }

  const lowered = rawDatabaseUrl.toLowerCase();
  return lowered.includes('sslmode=require') || lowered.includes('ssl=true') || lowered.includes('ssl=1')
    ? { rejectUnauthorized: false }
    : false;
}

function escapeIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function getDatabaseConfig() {
  const rawDatabaseUrl = (process.env.DATABASE_URL || '').trim();
  const ssl = getSslConfig(rawDatabaseUrl);

  if (rawDatabaseUrl) {
    const url = new URL(rawDatabaseUrl);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));

    if (!databaseName) {
      throw new Error('DATABASE_URL precisa incluir o nome do banco.');
    }

    const adminUrl = new URL(rawDatabaseUrl);
    adminUrl.pathname = '/postgres';

    return {
      databaseName,
      adminClientConfig: {
        connectionString: adminUrl.toString(),
        ssl,
      },
    };
  }

  const databaseName = process.env.DB_NAME;
  if (!databaseName) {
    throw new Error('Defina DATABASE_URL ou DB_NAME para criar a base.');
  }

  return {
    databaseName,
    adminClientConfig: {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_ADMIN_DATABASE || 'postgres',
      ssl,
    },
  };
}

function runSequelizeCli(command) {
  const sequelizeCliPath = require.resolve('sequelize-cli/lib/sequelize');
  const result = spawnSync(process.execPath, [sequelizeCliPath, ...command], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Falha ao executar sequelize-cli ${command.join(' ')}`);
  }
}

async function ensureDatabaseExists() {
  const { databaseName, adminClientConfig } = getDatabaseConfig();
  const client = new Client(adminClientConfig);

  await client.connect();

  try {
    const existingDatabase = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName]
    );

    if (existingDatabase.rowCount === 0) {
      await client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
      console.log(`Database created: ${databaseName}`);
    } else {
      console.log(`Database already exists: ${databaseName}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  await ensureDatabaseExists();
  runSequelizeCli(['db:migrate']);
  runSequelizeCli(['db:seed:all']);
  console.log('Database setup finished.');
}

main().catch((error) => {
  console.error('Database setup failed.');
  console.error(error.message);
  process.exit(1);
});
