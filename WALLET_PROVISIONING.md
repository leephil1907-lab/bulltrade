# Wallet provisioning for Blockchain Bullhorn

## Integration boundary
BullTrade uses a file-backed JSON database and manually verified deposits. This change adds a provider boundary for user-specific public deposit addresses. It does not switch deposits to automatic on-chain crediting or enable live withdrawals.

No private keys, seed phrases, signing secrets, or provider credentials are stored in db.json. The provider owns key generation and signing under its custody/MPC/KMS/HSM controls. BullTrade persists public address metadata only.

## Configure a custody adapter
Set these server-side environment variables in the deployment environment:
- WALLET_PROVIDER_URL: base URL of your private adapter service.
- WALLET_PROVIDER_API_KEY: server-only credential for that adapter.
- WALLET_SUPPORTED_NETWORKS: optional comma-separated list. Defaults to ethereum, polygon, arbitrum, optimism, base, bsc, bitcoin, litecoin, dogecoin, solana, tron, xrpl, cardano.

The adapter contract is POST /v1/user-wallets, with a stable idempotency key and JSON response { "wallets": [{ "network": "...", "address": "...", "walletId": "...", "memo": "...", "tag": "..." }] }. Implement it using the selected provider's official API and validate responses against its documented schema. Do not point this setting at an arbitrary public endpoint.

Provisioning is off when either setting is missing. Signup should still succeed if the provider is temporarily unavailable; errors are logged without credentials or provider response bodies.

## Persistence and API
Each wallet_addresses record contains internal row ID, user ID, network, public address, opaque provider wallet ID, optional memo/tag, status, and timestamp. GET /api/wallets/deposit-addresses returns only the authenticated user's public address records.

## Before accepting real deposits
1. Choose a provider and complete its business/compliance review for custody.
2. Implement and test the adapter against official sandbox APIs; verify chain-specific address formats and XRP destination tags / TRON memo semantics.
3. Build chain watchers/webhooks with signature verification, confirmation/finality rules, replay protection, and unique network/txid/output-index constraints.
4. Credit deposits only after independent chain verification, with idempotent ledger posting in a database transaction. Never credit from a client-submitted TXID or screenshot alone.
5. Build separate withdrawal approval and signer services with velocity limits, allowlists, risk checks, and auditable approvals. Web handlers must not sign arbitrary transactions.
6. Keep signing keys in provider MPC or KMS/HSM-backed signing; use least-privilege credentials, rotation, incident procedures, and recovery drills.
7. Run testnet and threat-model reviews before production funds are accepted.

## Known limitation
The current funding UI still includes legacy platform-wide addresses and the existing deposit workflow requests TXID + proof for manual review. The new per-user API is the integration seam; switch the UI and on-chain monitor only after a concrete provider adapter is implemented and tested end-to-end.
