
// Load base .env first
require('dotenv').config();
const { requestContext } = require('./utils/requestContext');
const fs = require('fs');
const path = require('path');

// Then load environment-specific .env.<NODE_ENV> to override base values
try {
  const env = process.env.NODE_ENV || 'development';
  const envPath = path.resolve(process.cwd(), `.env.${env}`);
  require('dotenv').config({ path: envPath });
} catch (e) {
  // Silently ignore if env-specific file does not exist
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const { authenticateToken, requireRole } = require('./middlewares/auth');
const { TokenBlocklist } = require('./models');
const { Op } = require('sequelize');
const cron = require('node-cron');
const { generatePendingTransactions } = require('./services/recurrenceService');
const { autoCloseProjectSessionsByCutoff, closeStaleRunningEntries } = require('./services/projectTimesheetService');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const storeRoutes = require('./routes/stores');
const footballTeamsRoutes = require('./routes/footballTeams');
const eventRoutes = require('./routes/events');
const eventOpenRoutes = require('./routes/eventsOpen');
const eventJamsRoutes = require('./routes/eventJams');
const { uploadRouter, uploadFileToDrive } = require('./routes/upload');
const filesRoutes = require('./routes/files');
const financialRoutes = require('./routes/financial');
const finRecurrenceRoutes = require('./routes/finRecurrences');
const finCommissionRoutes = require('./routes/finCommissions');
const finAnalyticsRoutes = require('./routes/finAnalytics');
const bankAccountRoutes = require('./routes/bankAccounts');
const partyRoutes = require('./routes/parties');
const finCategoryRoutes = require('./routes/finCategories');
const finCostCenterRoutes = require('./routes/finCostCenters');
const finTagRoutes = require('./routes/finTags');
const sysModuleRoutes = require('./routes/sysModules');
const eventJamMusicSuggestionRoutes = require('./routes/eventJamMusicSuggestions');
const musicCatalogRoutes = require('./routes/musicCatalog');
const organizationRoutes = require('./routes/organizations');
const storeInvitesRoutes = require('./routes/storeInvites');
const storeInvitesPublicRoutes = require('./routes/storeInvitesPublic');
const projectRoutes = require('./routes/project');

// Import middleware
const errorHandler = require('./middlewares/errorHandler');

// Import database connection
const { sequelize, testConnection } = require('./config/database');

// Import Firebase (trigger init log)
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
if (!isTestEnv) {
  require('./config/firebaseAdmin');
}

const app = express();
const debugRouter = require('./routes/debug');
app.use('/api/debug', debugRouter);

const PORT = process.env.PORT || 4000;

// CORREÇÃO OBRIGATÓRIA NO RENDER (resolve o erro do rate-limit + SSE)
app.set('trust proxy', 1); // ou true → essencial!

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'DM-APP API',
      version: '1.0.0',
      description: 'API para sistema de bares e restaurantes',
    },
    servers: [
      {
        url: process.env.API_PUBLIC_BASE_URL || `http://localhost:${PORT}`,
        description: process.env.NODE_ENV === 'production' ? 'Production server' : 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

const specs = swaggerJsdoc(swaggerOptions);

// Security middleware
app.use(helmet());
app.use(cors());

// Logger middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Compression middleware
app.use(compression());

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request Context Middleware (para métricas e logs)
app.use((req, res, next) => {
  const store = {
    requestId: require('uuid').v4(),
    routeKey: req.path,
    ip: req.ip,
    dbQueries: 0,
    cacheHits: 0
  };
  requestContext.run(store, () => {
    next();
  });
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
app.use(limiter);

// Speed limiter
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 500, // allow 500 requests per 15 minutes, then...
  delayMs: () => 500 // begin adding 500ms of delay per request
});
app.use(speedLimiter);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/stores', storeRoutes);
app.use('/api/v1/football-teams', footballTeamsRoutes);

// Rotas Públicas Específicas (antes das genéricas para evitar captura por :id)
app.use('/api/events/public', (req, res, next) => {
  req.url = '/public'; // Reescreve para casar com a rota '/' ou '/public' dentro do router
  eventOpenRoutes(req, res, next);
});

app.use('/api/v1/events', eventRoutes);
app.use('/api/events', eventRoutes); // Alias for legacy/frontend compatibility
app.use('/api/v1/event-jams', eventJamsRoutes); // Alias
app.use('/api/v1/events', eventJamsRoutes); // Mount jams under events too if needed, but separate is safer
app.use('/api/events', eventJamsRoutes); // Alias for legacy/frontend compatibility
app.use('/api/public/v1/events', eventOpenRoutes);
app.use('/api/public/v1/store-invites', storeInvitesPublicRoutes);
app.use('/api/v1/project', projectRoutes);
app.use('/api/v1/files', filesRoutes);
app.use('/api/v1/financial', financialRoutes);
app.use('/api/v1/financial/recurrences', finRecurrenceRoutes);
app.use('/api/v1/financial/commissions', finCommissionRoutes);
app.use('/api/v1/financial/analytics', finAnalyticsRoutes);
app.use('/api/v1/bank-accounts', bankAccountRoutes);
app.use('/api/v1/financial/bank-accounts', bankAccountRoutes);
app.use('/api/v1/parties', partyRoutes);
app.use('/api/v1/financial/parties', partyRoutes);
app.use('/api/v1/financial/categories', finCategoryRoutes);
app.use('/api/v1/financial/cost-centers', finCostCenterRoutes);
app.use('/api/v1/financial/tags', finTagRoutes);
app.use('/api/v1/sys-modules', sysModuleRoutes);
app.use('/api/v1/event-jam-music-suggestions', eventJamMusicSuggestionRoutes);
app.use('/api/v1/music-suggestions', eventJamMusicSuggestionRoutes); // Alias for frontend compatibility
app.use('/api/v1/music-catalog', musicCatalogRoutes);
app.use('/api/v1/organizations', organizationRoutes);
app.use('/api/v1/store-invites', storeInvitesRoutes);

// Upload routes
app.use('/api/v1/upload', uploadRouter);
app.use('/api/v1/uploads', uploadRouter);
app.use('/api/uploads', uploadRouter);

// Error handler middleware
app.use(errorHandler);

// Cron Jobs
// Gerar transações pendentes diariamente às 00:01
if (!isTestEnv) {
  cron.schedule('1 0 * * *', async () => {
    console.log('Running daily recurrence check...');
    try {
      await generatePendingTransactions();
      console.log('Daily recurrence check completed.');
    } catch (error) {
      console.error('Daily recurrence check failed:', error);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try {
      await autoCloseProjectSessionsByCutoff();
      await closeStaleRunningEntries();
    } catch (error) {
      console.error('Project timesheet maintenance failed:', error);
    }
  });
}

// Start server
if (!isTestEnv) {
  const server = app.listen(PORT, async () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
    try {
      await testConnection(); // Usa a função de teste que tem logs coloridos
      console.log('Database connected!');
      // await sequelize.sync(); // Disable sync in production/dev usually
    } catch (error) {
      console.error('Unable to connect to the database:', error);
    }
  });
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`);
  // Close server & exit process
  // server.close(() => process.exit(1));
});

module.exports = app;
