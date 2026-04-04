const express = require('express');
const request = require('supertest');

jest.mock('../middlewares/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: 1, role: 'customer' };
    next();
  }
}));

jest.mock('../config/database', () => ({
  sequelize: {
    transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn(), LOCK: { UPDATE: 'UPDATE' } }))
  }
}));

jest.mock('../models', () => ({
  Event: { findOne: jest.fn() },
  EventQuestion: {},
  EventResponse: {},
  EventAnswer: {},
  User: { findByPk: jest.fn() },
  EventGuest: { findOne: jest.fn(), create: jest.fn() },
  TokenBlocklist: {},
  EventTicketType: { findOne: jest.fn(), create: jest.fn() },
  EventTicket: { findOne: jest.fn() }
}));

const routes = require('../routes/eventsOpen');
const { Event, User, EventTicket } = require('../models');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public/v1/events', routes);
  return app;
}

describe('Events self-checkin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns need_ticket when user has no ticket', async () => {
    Event.findOne.mockResolvedValue({
      id: 10,
      id_code: 'evt-1',
      status: 'published',
      date: '2026-04-06',
      end_date: '2026-04-06',
      start_time: '10:00:00',
      end_time: '23:00:00',
      auto_checkin: true
    });
    User.findByPk.mockResolvedValue({ id: 1, name: 'User', email: 'u@test.com' });
    EventTicket.findOne.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app).post('/api/public/v1/events/evt-1/self-checkin').send({});
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('need_ticket');
  });
});

