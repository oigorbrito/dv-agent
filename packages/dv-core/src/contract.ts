// Constantes do contrato de contabilidade p1-run-accounting-v4 e do schema do ledger, usadas pelo writer e pelo verificador.
export const CONTRACT_ID = "p1-run-accounting-v4";
export const CONTRACT_FILE = "contracts/run-accounting-contract-v4.json";
/** v5 proposto (PROPOSED_UNRATIFIED): acrescenta a regra condicional do agy. Runs com agy exigem v5. */
export const CONTRACT_V5_ID = "p1-run-accounting-v5";
export const CONTRACT_V5_FILE = "contracts/run-accounting-contract-v5.json";
/** Versões de contrato que o verificador aceita em run_started. */
export const SUPPORTED_CONTRACT_IDS: readonly string[] = [CONTRACT_ID, CONTRACT_V5_ID];
export const LEDGER_SCHEMA = "dv-run-ledger-v2";
export const REDACTED = "[REDACTED]";
