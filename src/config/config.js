
const path = require('path');
// Load base .env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Load environment-specific .env.<NODE_ENV> to override base values
try {
  const env = process.env.NODE_ENV || 'development';
  require('dotenv').config({ path: path.resolve(__dirname, `../../.env.${env}`) });
} catch (e) {
  // Ignore if env-specific file does not exist
}

const parseBooleanEnv = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

const shouldUseSslForHostedPostgres = (rawDatabaseUrl) => {
  try {
    const hostname = new URL(rawDatabaseUrl).hostname.toLowerCase();
    return hostname.endsWith('.render.com') || hostname.endsWith('.render.internal');
  } catch (error) {
    return false;
  }
};

const shouldUseSsl = (() => {
  const explicit = parseBooleanEnv(process.env.DB_SSL);
  if (explicit !== undefined) return explicit;
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) return false;
  const lowered = databaseUrl.toLowerCase();
  return lowered.includes('sslmode=require')
    || lowered.includes('ssl=true')
    || lowered.includes('ssl=1')
    || shouldUseSslForHostedPostgres(databaseUrl);
})();

module.exports = {
  development: {
    use_env_variable: 'DATABASE_URL', // Use DATABASE_URL for Postgres connection
    dialect: 'postgres',
    logging: process.env.DB_LOGGING === 'true' ? console.log : false,
    dialectOptions: shouldUseSsl
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      : {}
  },
  test: {
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'beerclub_test',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    dialect: 'mysql',
    logging: false,
    dialectOptions: {
      charset: 'utf8mb4'
    }
  },
  production: {
    use_env_variable: 'DATABASE_URL', // Use DATABASE_URL for Postgres connection
    dialect: 'postgres',
    logging: false,
    dialectOptions: shouldUseSsl
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      : {}
  }
};
