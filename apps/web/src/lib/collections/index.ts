/**
 * AR Collections workflow — public surface.
 *
 * A workflow layer on top of the existing AR aging / DSO (see
 * app/api/invoices/collections): a prioritized worklist with a recommended next
 * action, a deterministic dunning cadence whose letters the AI phrases (human
 * approves the send), and promise-to-pay tracking that flags broken promises.
 * Everything here is pure/testable; all I/O lives in app/api/collections/*.
 */

export * from './cadence';
export * from './prediction';
export * from './worklist';
export * from './promises';
export * from './dunning-copy';
