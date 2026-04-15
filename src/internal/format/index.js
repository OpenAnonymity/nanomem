/**
 * Barrel re-export for all bullet utilities.
 *
 * @typedef {import('../../types.js').Tier} Tier
 * @typedef {import('../../types.js').Status} Status
 * @typedef {import('../../types.js').Source} Source
 * @typedef {import('../../types.js').Confidence} Confidence
 * @typedef {import('../../types.js').Bullet} Bullet
 * @typedef {import('../../types.js').EnsureBulletMetadataOptions} EnsureBulletMetadataOptions
 * @typedef {import('../../types.js').CompactionResult} CompactionResult
 * @typedef {import('../../types.js').CompactBulletsOptions} CompactBulletsOptions
 */
export * from './normalize.js';
export * from './parser.js';
export * from './scoring.js';
export * from './compaction.js';
