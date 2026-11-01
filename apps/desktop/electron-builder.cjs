const branding = require("../../branding.json");

module.exports = {
  appId: branding.appId,
  productName: branding.productName,
  directories: { output: "release", buildResources: "build" },
  files: [
    "dist/main/**",
    "dist/preload/**",
    "dist/renderer/**",
    "package.json",
    "!node_modules/**",
  ],
  extraResources: [
    { from: "../../LICENSE", to: "licenses/Catalex-AGPL-3.0.txt" },
    { from: "../../NOTICE", to: "licenses/Catalex-NOTICE.txt" },
    { from: "../../LICENSES", to: "licenses/upstream" },
    { from: "dist/native", to: "native" },
    { from: "../desktop-sidecar/dist", to: "claude-bridge" },
    { from: `backend/resources/${branding.namespace}`, to: branding.namespace },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    // Preview integrity signing does not identify a publisher or use credentials.
    identity: "-",
    notarize: false,
    target: "dmg",
    category: "public.app-category.productivity",
    icon: "build/icons/icon.icns",
    minimumSystemVersion: "13.0",
    hardenedRuntime: true,
  },
  win: { target: "nsis", icon: "build/icons/icon.ico" },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: {
    target: "AppImage",
    executableName: branding.namespace,
    category: "Office",
    icon: "build/icons",
  },
  publish: null,
};
