import type { Storage } from '../storage/adapter.js';
import type { Bucket, BucketPeriod } from './periods.js';

export interface TargetProgress {
  target: number | null;
  current: number;
  /** `current / target`, clamped to [0, 1]; null if no target. */
  ratio: number | null;
}

export interface StatsService {
  // TODO: implement bucket() / streak() / targetProgress()
  bucket(
    trackerId: string,
    range: { start: string; end: string },
    period: BucketPeriod,
  ): Promise<Bucket[]>;

  streak(trackerId: string): Promise<{ current: number; longest: number }>;

  targetProgress(trackerId: string, at?: string): Promise<TargetProgress>;
}

export function createStatsService(_storage: Storage): StatsService {
  return {
    async bucket() {
      throw new Error('StatsService.bucket: not yet implemented');
    },
    async streak() {
      throw new Error('StatsService.streak: not yet implemented');
    },
    async targetProgress() {
      throw new Error('StatsService.targetProgress: not yet implemented');
    },
  };
}
