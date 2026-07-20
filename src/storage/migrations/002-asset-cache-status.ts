export const version = 2;

// ADD COLUMN preserves the existing assets table instead of rebuilding it.
export const sql = `
ALTER TABLE assets
ADD COLUMN cache_status TEXT NOT NULL DEFAULT 'usable'
CHECK (cache_status IN ('usable', 'unverified'));
`;
