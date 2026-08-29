import type { CrashfixConfig } from './config.js';

export type IssueType = 'crash' | 'anr';

export interface Issue {
  id: string;
  title: string;
  subtitle: string;
  type: IssueType;
  eventCount: number;
  userCount: number;
  firstSeenVersion: string;
  lastSeenVersion: string;
  stackTrace: string;
  sampleEventUrl: string;
  blameFile?: string;
}

export type IssueStatus =
  | 'FETCHED'
  | 'ANALYZED'
  | 'UNFIXABLE'
  | 'SOLVED'
  | 'IN_REVIEW'
  | 'NEEDS_REVISION'
  | 'APPROVED'
  | 'PUSHED'
  | 'PARTIALLY_PUSHED'
  | 'REJECTED'
  | 'FAILED';

export interface RepoInfo {
  name: string;
  path: string;
  remote: string;
  provider: 'github' | 'bitbucket' | 'gitlab' | 'unknown';
  buildCommand?: string;
}

export interface IssueRecord {
  issue: Issue;
  status: IssueStatus;
  slug: string;
  branch: string;
  wave: number;
  slot?: number;
  affectedRepos: string[];
  reportPath?: string;
  reviewPath?: string;
  prUrls: Record<string, string>;
  buildResult?: ValidationResult;
  decision?: Decision;
  notes?: string;
  failureStage?: string;
}

export interface Decision {
  issueId: string;
  verdict: 'approve' | 'reject' | 'skip';
  comments?: string;
}

export interface ValidationResult {
  mode: 'build' | 'lint' | 'none';
  ok: boolean;
  tail: string;
  timedOut: boolean;
}

export interface RunState {
  version: number;
  createdAt: string;
  config: CrashfixConfig;
  issues: Record<string, IssueRecord>;
  waveOrder: string[][];
  currentWave: number;
  phase: 'fetch' | 'wave' | 'done';
}
