'use strict';

/**
 * Optional HubSpot CRM adapter for Bulltrade.
 *
 * HubSpot owns customer/support CRM only. Bulltrade remains authoritative for
 * authentication, wallets, orders, positions, trades and the financial ledger.
 *
 * Set HUBSPOT_ACCESS_TOKEN in the server environment to enable live sync.
 * If it is absent or a request fails, CRM sync is intentionally non-blocking.
 */

const BASE = 'https://api.hubapi.com';
const TIMEOUT_MS = 7000;

function enabled() {
  return !!String(process.env.HUBSPOT_ACCESS_TOKEN || '').trim();
}

async function request(method, pathname, body) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'HUBSPOT_ACCESS_TOKEN is not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        Authorization: 'Bearer ' + process.env.HUBSPOT_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!res.ok) return { ok: false, status: res.status, error: data };
    return { ok: true, status: res.status, data };
  } catch (error) {
    return { ok: false, error: error.message || 'HubSpot request failed' };
  } finally {
    clearTimeout(timer);
  }
}

function contactProperties(user) {
  const p = {
    email: String(user.email || ''),
    firstname: String(user.firstName || user.name || '').trim().split(/\s+/)[0] || '',
    lastname: String(user.lastName || '').trim(),
    phone: String(user.phone || ''),
    country: String(user.country || ''),
    lifecyclestage: 'lead'
  };
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== ''));
}

async function findContactByEmail(email) {
  return request('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname', 'phone', 'country', 'lifecyclestage'],
    limit: 1
  });
}

async function syncContact(user, extra = {}) {
  if (!enabled()) return { ok: false, skipped: true };

  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return { ok: false, skipped: true, reason: 'missing email' };

  const properties = Object.assign(contactProperties(user), extra);
  const found = await findContactByEmail(email);

  if (found.ok && found.data && Array.isArray(found.data.results) && found.data.results[0]) {
    const id = found.data.results[0].id;
    const updated = await request('PATCH', '/crm/v3/objects/contacts/' + encodeURIComponent(id), { properties });
    return Object.assign(updated, { action: 'updated', contactId: id });
  }

  const created = await request('POST', '/crm/v3/objects/contacts', { properties });
  if (created.ok) {
    return Object.assign(created, {
      action: 'created',
      contactId: created.data && created.data.id ? created.data.id : null
    });
  }

  // A concurrent signup may have created the contact between search and create.
  if (created.status === 409) {
    const retry = await findContactByEmail(email);
    if (retry.ok && retry.data && retry.data.results && retry.data.results[0]) {
      const id = retry.data.results[0].id;
      const updated = await request('PATCH', '/crm/v3/objects/contacts/' + encodeURIComponent(id), { properties });
      return Object.assign(updated, { action: 'updated-after-conflict', contactId: id });
    }
  }

  return Object.assign(created, { action: 'create-failed' });
}

async function createSupportTicket({ subject, content, priority, category, contactId }) {
  const properties = {
    subject: String(subject || 'Bulltrade support request').slice(0, 255),
    content: String(content || '').slice(0, 6000),
    hs_ticket_priority: String(priority || 'MEDIUM').toUpperCase(),
    hs_ticket_category: String(category || 'Customer support')
  };
  const associations = [];
  if (contactId) {
    associations.push({
      to: { id: String(contactId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }]
    });
  }
  const body = { properties };
  if (associations.length) body.associations = associations;
  return request('POST', '/crm/v3/objects/tickets', body);
}

module.exports = {
  enabled,
  syncContact,
  createSupportTicket
};
