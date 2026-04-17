
// Load base .env first
require('dotenv').config();
const { requestContext } = require('./utils/requestContext');
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

const { authenticateToken } = require('./middlewares/auth');
const { TokenBlocklist } = require('./models');
const { Op } = require('sequelize');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const { uploadRouter } = require('./routes/upload');
const filesRoutes = require('./routes/files');
const pdfRoutes = require('./routes/pdf');

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

const PORT = process.env.PORT || 4000;

// CORREÇÃO OBRIGATÓRIA NO RENDER (resolve o erro do rate-limit + SSE)
app.set('trust proxy', 1);

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'VNW Resgate API',
      version: '1.0.0',
      description: 'API de CRUD de Usuários para a plataforma VNW Resgate',
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
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Speed limiter
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 500,
  delayMs: () => 500
});
app.use(speedLimiter);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/files', filesRoutes);
app.use('/api/v1/pdf', pdfRoutes);

// Upload routes
app.use('/api/v1/upload', uploadRouter);
app.use('/api/v1/uploads', uploadRouter);

// Error handler middleware
app.use(errorHandler);

// Start server
if (!isTestEnv) {
  const server = app.listen(PORT, async () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
    try {
      await testConnection();
      console.log('Database connected!');
    } catch (error) {
      console.error('Unable to connect to the database:', error);
    }
  });
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`);
});

module.exports = app;
