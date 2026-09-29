/**
 * Body for a `test.todo`: it throws, so `bun test --todo` keeps reporting the threat as
 * unimplemented instead of passing an empty test. Name the milestone that makes it live.
 */
export function pending(milestone: string): () => never {
  return () => {
    throw new Error(`pending until ${milestone}`);
  };
}
