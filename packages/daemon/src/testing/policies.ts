/**
 * A plain-object policy module source for tests: no imports, so it loads from any temp
 * directory. `verdict` is what `decide` returns; `extra` is spliced into the object.
 */
export function policyModule(name: string, version = 1, verdict = "allow", extra = ""): string {
  return `export default {
  name: ${JSON.stringify(name)}, version: ${version}, owner: "tests",
  when: () => true, decide: () => ${JSON.stringify(verdict)}, reason: "test policy ${name}",
  ${extra}
};
`;
}
