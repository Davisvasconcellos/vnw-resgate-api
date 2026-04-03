const RESERVED = new Set([
  'api',
  'app',
  'admin',
  'auth',
  'cdn',
  'docs',
  'files',
  'help',
  'internal',
  'mail',
  'master',
  'panel',
  'root',
  'static',
  'support',
  'www'
]);

const normalizeStoreSlug = (value) => {
  if (value === undefined || value === null) return '';
  const s = String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return s;
};

const isReservedStoreSlug = (slug) => RESERVED.has(String(slug || '').toLowerCase());

module.exports = {
  normalizeStoreSlug,
  isReservedStoreSlug
};

