const jwt = require('jsonwebtoken');
const { User, TokenBlocklist } = require('../models');

// Cache em memória para blocklist de tokens (evita query ao banco a cada request)
// TTL de 60 segundos: tempo máximo que um token invalidado pode ser considerado válido
const blocklistCache = new Map();
const BLOCKLIST_CACHE_TTL_MS = 60 * 1000; // 60 segundos

// Cache em memória para usuários (evita consulta ao banco em cada request autenticada)
const userCache = new Map();
const USER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos

const isTokenBlocked = async (token) => {
  // Verifica cache primeiro
  const cached = blocklistCache.get(token);
  if (cached !== undefined) {
    return cached;
  }
  // Consulta banco apenas se não estiver em cache
  const blocked = await TokenBlocklist.findOne({ where: { token } });
  const result = !!blocked;
  blocklistCache.set(token, result);
  // Remove do cache após TTL
  setTimeout(() => blocklistCache.delete(token), BLOCKLIST_CACHE_TTL_MS);
  return result;
};

// Middleware para validar token e popular req.user
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token não fornecido' });
  }

  try {
    // Verificar se o token está na blocklist (com cache em memória)
    const blocked = await isTokenBlocked(token);
    if (blocked) {
      return res.status(401).json({ message: 'Token inválido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verifica cache de usuário primeiro
    const cachedUser = userCache.get(decoded.userId);

    if (cachedUser && (Date.now() - cachedUser.timestamp < USER_CACHE_TTL_MS)) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const user = await User.findByPk(decoded.userId, {
          attributes: ['id', 'role', 'email', 'plan_id']
        });

        if (!user) {
          userCache.delete(decoded.userId);
          return res.status(401).json({ message: 'Usuário não encontrado' });
        }

        const userData = {
          userId: user.id,
          email: user.email,
          role: user.role,
          planId: user.plan_id
        };

        userCache.set(decoded.userId, {
          data: userData,
          timestamp: Date.now()
        });

        req.user = userData;
        return next();
      }

      req.user = cachedUser.data;
      return next();
    }

    // Busca usuário no banco para garantir que ainda existe e está ativo
    const user = await User.findByPk(decoded.userId, {
      attributes: ['id', 'role', 'email', 'plan_id']
    });

    if (!user) {
      return res.status(401).json({ message: 'Usuário não encontrado' });
    }

    // Popula req.user com dados frescos do banco (garante role atualizada)
    const userData = {
      userId: user.id,
      email: user.email,
      role: user.role,
      planId: user.plan_id
    };

    // Salva no cache
    userCache.set(decoded.userId, {
      data: userData,
      timestamp: Date.now()
    });

    // Limpeza automática do cache
    setTimeout(() => {
      const entry = userCache.get(decoded.userId);
      if (entry && Date.now() - entry.timestamp >= USER_CACHE_TTL_MS) {
        userCache.delete(decoded.userId);
      }
    }, USER_CACHE_TTL_MS);

    req.user = userData;

    next();
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Erro no token:', err.message, err.name);
      if (err.expiredAt) console.error('Token expirado em:', err.expiredAt);
    }
    return res.status(403).json({ message: 'Token inválido ou expirado' });
  }
};

// Middleware para checar roles
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Não autenticado' });
    }

    // Admin e Master têm todos os acessos
    const highPrivilegeRoles = ['admin', 'master'];

    if (
      highPrivilegeRoles.includes(req.user.role) ||
      roles.includes(req.user.role)
    ) {
      return next();
    }

    return res.status(403).json({ 
      error: 'Forbidden',
      message: `Acesso negado. Seu perfil não possui permissão para este recurso.`
    });
  };
};

module.exports = {
  authenticateToken,
  requireRole
};
