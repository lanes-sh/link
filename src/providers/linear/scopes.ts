import type { ScopeMeaning } from '../scopes.ts';

/** Linear's two scopes, which are as plain as they look. */
export const LINEAR_SCOPE_MEANINGS: Record<string, ScopeMeaning> = {
  read: { meaning: 'read-only access' },
  write: { meaning: 'create and modify' },
};
