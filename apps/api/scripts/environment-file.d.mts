export function populateAuthSecret(contents: string, authSecret: string): string;

export function backfillMissingEnvironmentVariables(
  existing: string,
  example: string,
  authSecret: string,
): {
  contents: string;
  addedKeys: string[];
};
