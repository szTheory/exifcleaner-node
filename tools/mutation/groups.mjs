// Group map for the mutation score (MUT-03, D-14). Node builtins only.
//
// Every src/**/*.ts file must belong to exactly one group in
// mutation-floors.json; a file in zero groups would be unscored and a file in
// two would be double counted, so checkGroupCoverage reports both.

/** Translate a glob (`**`, `*`, `{a,b}`, literals) to an anchored RegExp. */
export function globToRegExp(glob) {
  let out = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?"; // zero or more directories
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "{") {
      braceDepth++;
      out += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      out += ")";
    } else if (c === "," && braceDepth > 0) {
      out += "|";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }
  if (braceDepth !== 0) throw new Error(`unbalanced brace in glob ${glob}`);
  return new RegExp(`^${out}$`);
}

/** Names of the groups whose globs match the repo-relative path. */
export function groupsFor(path, groups) {
  const names = [];
  for (const [name, group] of Object.entries(groups)) {
    if (group.globs.some((g) => globToRegExp(g).test(path))) names.push(name);
  }
  return names;
}

/** Problem strings for every path matching zero or more than one group. */
export function checkGroupCoverage(paths, groups) {
  const problems = [];
  for (const path of paths) {
    const names = groupsFor(path, groups);
    if (names.length === 0) problems.push(`${path}: matches 0 groups`);
    else if (names.length > 1)
      problems.push(
        `${path}: matches ${names.length} groups (${names.join(", ")})`,
      );
  }
  return problems;
}
