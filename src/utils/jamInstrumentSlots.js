const normalizeInstrument = (value) => String(value || '').trim().toLowerCase();

const mergeSlot = (acc, next) => {
  const slots = parseInt(next.slots ?? next.total ?? 1, 10);
  acc.slots += Number.isFinite(slots) && slots > 0 ? slots : 1;
  acc.required = acc.required || !!next.required;
  acc.fallback_allowed = acc.fallback_allowed || !!next.fallback_allowed;
  return acc;
};

const normalizeJamInstrumentSlotsPayload = (slots) => {
  const list = Array.isArray(slots) ? slots : [];
  const byInstrument = new Map();

  for (const s of list) {
    const instrument = normalizeInstrument(s && s.instrument);
    if (!instrument) continue;
    if (!byInstrument.has(instrument)) {
      byInstrument.set(instrument, {
        instrument,
        slots: 0,
        required: s && s.required !== undefined ? !!s.required : true,
        fallback_allowed: s && s.fallback_allowed !== undefined ? !!s.fallback_allowed : true
      });
    }
    mergeSlot(byInstrument.get(instrument), s || {});
  }

  return Array.from(byInstrument.values());
};

const normalizeJamInstrumentSlotsRows = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const byInstrument = new Map();

  for (const row of list) {
    const r = row && typeof row.toJSON === 'function' ? row.toJSON() : (row || {});
    const instrument = normalizeInstrument(r.instrument);
    if (!instrument) continue;
    if (!byInstrument.has(instrument)) {
      byInstrument.set(instrument, {
        id: r.id ?? null,
        instrument,
        slots: 0,
        required: !!r.required,
        fallback_allowed: !!r.fallback_allowed
      });
    }
    const acc = byInstrument.get(instrument);
    if (acc.id === null && r.id !== undefined) acc.id = r.id;
    mergeSlot(acc, r);
  }

  return Array.from(byInstrument.values());
};

module.exports = {
  normalizeJamInstrumentSlotsPayload,
  normalizeJamInstrumentSlotsRows
};

