'use strict';

/**
 * Provider-neutral exchange boundary. No live provider is registered here.
 * Market-data adapters are not order-execution adapters. Keep live trading
 * blocked until a reviewed provider and durable order reconciliation exist.
 */
const REQUIRED_METHODS = Object.freeze(['getCapabilities', 'getBalances', 'submitOrder', 'getOrder', 'cancelOrder', 'listFills']);

class ExchangeUnavailableError extends Error {
  constructor(message = 'No approved exchange execution provider is configured.') {
    super(message);
    this.name = 'ExchangeUnavailableError';
    this.code = 'EXCHANGE_UNAVAILABLE';
    this.status = 503;
  }
}

function validateAdapter(adapter) {
  const missing = REQUIRED_METHODS.filter(name => !adapter || typeof adapter[name] !== 'function');
  if (missing.length) {
    const error = new TypeError('Exchange adapter is missing required methods: ' + missing.join(', '));
    error.code = 'INVALID_EXCHANGE_ADAPTER';
    throw error;
  }
  return adapter;
}

function createUnavailableAdapter(provider = 'none') {
  const unavailable = async () => { throw new ExchangeUnavailableError(); };
  return Object.freeze({
    provider,
    configured: false,
    status: () => ({ configured: false, provider, executionEnabled: false, reason: 'No approved exchange execution provider is configured.' }),
    getCapabilities: unavailable,
    getBalances: unavailable,
    submitOrder: unavailable,
    getOrder: unavailable,
    cancelOrder: unavailable,
    listFills: unavailable
  });
}

function getAdapterStatus(adapter = createUnavailableAdapter()) {
  if (!adapter || typeof adapter.status !== 'function') {
    return { configured: false, provider: 'none', executionEnabled: false, reason: 'Exchange adapter is not registered.' };
  }
  const status = adapter.status();
  return {
    configured: status.configured === true,
    provider: String(status.provider || 'unknown'),
    executionEnabled: status.executionEnabled === true,
    reason: String(status.reason || '')
  };
}

module.exports = { REQUIRED_METHODS, ExchangeUnavailableError, validateAdapter, createUnavailableAdapter, getAdapterStatus };
