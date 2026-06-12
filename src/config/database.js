require('dotenv').config();
const { Sequelize } = require('sequelize');
const { requestContext } = require('../utils/requestContext');

// Database configuration
const databaseUrl = (process.env.DATABASE_URL || '').trim();
const dialect = process.env.DB_DIALECT || (databaseUrl ? 'postgres' : 'postgres');
const isPostgres = dialect === 'postgres' || !!databaseUrl;

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
  if (!databaseUrl) return false;
  const lowered = databaseUrl.toLowerCase();
  return lowered.includes('sslmode=require')
    || lowered.includes('ssl=true')
    || lowered.includes('ssl=1')
    || shouldUseSslForHostedPostgres(databaseUrl);
})();

const commonOptions = {
  dialect: isPostgres ? 'postgres' : dialect, // Force postgres if detected
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
  pool: {
    max: parseInt(process.env.DB_POOL_MAX) || 15,
    min: parseInt(process.env.DB_POOL_MIN) || 2,
    acquire: 60000, // Aumentado para 60s
    idle: 10000
  },
  define: {
    timestamps: true,
    underscored: true,
    freezeTableName: true
  },
  dialectOptions: isPostgres
    ? (shouldUseSsl
        ? {
            ssl: {
              require: true,
              rejectUnauthorized: false
            }
          }
        : {})
    : {
        charset: 'utf8mb4'
      }
};

const sequelize = databaseUrl
  ? new Sequelize(databaseUrl, commonOptions)
  : new Sequelize(
      process.env.DB_NAME || 'beerclub',
      process.env.DB_USER || 'root',
      process.env.DB_PASSWORD || '',
      {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
        ...commonOptions
      }
    );

// Global query counter for monitoring
sequelize.dbQueries = 0;

// Centralized hook to count all queries from all models globally
sequelize.addHook('beforeQuery', () => {
  sequelize.dbQueries++;
  
  // Attribute query to current request context if available
  const context = requestContext.getStore();
  if (context) {
    context.dbQueries++;
  }
});

// Test connection
const testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection has been established successfully.');
  } catch (error) {
    console.error('❌ Unable to connect to the database:', error);
  }
};

module.exports = {
  sequelize,
  testConnection
};
