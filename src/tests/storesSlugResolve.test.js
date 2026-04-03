const express = require('express');
const request = require('supertest');

jest.mock('../middlewares/auth', () => ({
  authenticateToken: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
  requireModule: () => (req, res, next) => next()
}));

jest.mock('../models', () => ({
  sequelize: {},
  Store: { findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() },
  Organization: {},
  User: {},
  Product: {},
  StoreUser: { findOne: jest.fn(), destroy: jest.fn() },
  StoreSchedule: {},
  StoreMember: {}
}));

const storeRoutes = require('../routes/stores');
const { Store } = require('../models');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/stores', storeRoutes);
  return app;
}

describe('Stores public slug endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/stores/check-slug', () => {
    it('returns 400 when slug missing', async () => {
      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/check-slug');
      expect(res.statusCode).toBe(400);
    });

    it('returns reserved when slug is reserved', async () => {
      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/check-slug').query({ slug: 'admin' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.available).toBe(false);
      expect(res.body.data.reason).toBe('reserved');
    });

    it('returns available=false when slug exists', async () => {
      Store.findOne.mockResolvedValue({ id_code: 'store-1', slug: 'clientea' });
      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/check-slug').query({ slug: 'ClienteA' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.slug).toBe('clientea');
      expect(res.body.data.available).toBe(false);
    });

    it('returns available=true when slug is free', async () => {
      Store.findOne.mockResolvedValue(null);
      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/check-slug').query({ slug: 'Cliente A' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.slug).toBe('cliente-a');
      expect(res.body.data.available).toBe(true);
    });
  });

  describe('GET /api/v1/stores/resolve', () => {
    it('returns 400 when subdomain missing', async () => {
      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/resolve');
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when store not found', async () => {
      Store.findOne.mockResolvedValue(null);
      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/resolve').query({ subdomain: 'cliente-a' });
      expect(res.statusCode).toBe(404);
    });

    it('returns store + organization when found', async () => {
      Store.findOne.mockResolvedValue({
        id_code: 'store-uuid-1',
        name: 'Cliente A',
        slug: 'cliente-a',
        status: 'active',
        logo_url: 'https://example.com/logo.png',
        banner_url: null,
        organization: {
          id_code: 'org-uuid-1',
          name: 'Org A',
          status: 'active',
          logo_url: 'https://example.com/org-logo.png',
          banner_url: null
        }
      });

      const app = makeApp();
      const res = await request(app).get('/api/v1/stores/resolve').query({ subdomain: 'Cliente A' });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store.slug).toBe('cliente-a');
      expect(res.body.data.organization.id_code).toBe('org-uuid-1');
    });
  });
});

