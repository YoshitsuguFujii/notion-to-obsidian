import * as initial from './001-initial.js';

export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [initial];
