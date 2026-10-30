import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Display names can change independently. Technical renames must also update
// static package/crate/resource names, or fail here before building an installer.
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");
const brand = JSON.parse(read("branding.json"));
assert.ok(
  typeof brand.productName === "string" &&
    brand.productName.trim() &&
    !/[\r\n]/.test(brand.productName),
);
assert.match(brand.namespace, /^[a-z][a-z0-9-]*$/);
assert.match(brand.appId, /^[a-z][a-z0-9.-]+$/);
assert.ok(
  typeof brand.profileDirectory === "string" &&
    brand.profileDirectory &&
    !/[\\/\r\n]/.test(brand.profileDirectory) &&
    ![".", ".."].includes(brand.profileDirectory),
);
for (const [file, suffix] of [
  ["package.json", "root"],
  ["apps/desktop/package.json", "desktop"],
  ["apps/desktop-sidecar/package.json", "desktop-sidecar"],
]) {
  assert.equal(
    JSON.parse(read(file)).name,
    `@${brand.namespace}/${suffix}`,
    `${file}: update the package name with the namespace`,
  );
}
assert.ok(
  read("apps/desktop/backend/Cargo.toml").includes(
    `name = "${brand.namespace}-desktop"`,
  ),
  "Update the native crate name with the namespace",
);
assert.ok(
  read("packages/document-core/Cargo.toml").includes(
    `name = "${brand.namespace}-document-core"`,
  ),
  "Update the document-core crate name with the namespace",
);
assert.ok(
  existsSync(
    path.join(
      root,
      "apps/desktop/backend/resources",
      brand.namespace,
      "skills",
    ),
  ),
  "Update the bundled resource directory with the namespace",
);
console.log(
  `Branding is consistent: ${brand.productName} (${brand.namespace})`,
);
