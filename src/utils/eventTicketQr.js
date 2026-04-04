const jwt = require('jsonwebtoken');

const getSecret = () => process.env.JWT_SECRET;

const buildEventTicketQrToken = ({ ticket_id, event_id, expires_at }) => {
  const secret = getSecret();
  if (!secret) return null;

  const expMs = expires_at ? new Date(expires_at).getTime() : null;
  if (!expMs || Number.isNaN(expMs)) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = Math.floor(expMs / 1000);
  const ttl = expSec - nowSec;
  if (ttl <= 0) return null;

  return jwt.sign(
    { typ: 'event_ticket', tid: ticket_id, eid: event_id },
    secret,
    { expiresIn: ttl }
  );
};

const verifyEventTicketQrToken = (token) => {
  const secret = getSecret();
  if (!secret) {
    const err = new Error('missing_jwt_secret');
    err.code = 'missing_jwt_secret';
    throw err;
  }
  const payload = jwt.verify(token, secret);
  if (!payload || payload.typ !== 'event_ticket' || !payload.tid || !payload.eid) {
    const err = new Error('invalid_ticket_token');
    err.code = 'invalid_ticket_token';
    throw err;
  }
  return payload;
};

module.exports = {
  buildEventTicketQrToken,
  verifyEventTicketQrToken
};

