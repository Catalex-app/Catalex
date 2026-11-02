const preview = require("./electron-builder.cjs");

// A missing profile must fail rather than silently skip notarization in v26.
if (!process.env.APPLE_KEYCHAIN_PROFILE?.trim()) {
  throw new Error(
    "Set APPLE_KEYCHAIN_PROFILE to your saved notarization profile.",
  );
}
if (process.env.CSC_NAME === "-") {
  throw new Error(
    "Signed releases require a Developer ID Application identity.",
  );
}

module.exports = {
  ...preview,
  forceCodeSigning: true,
  directories: { ...preview.directories, output: "release/signed" },
  mac: {
    ...preview.mac,
    identity: undefined,
    type: "distribution",
    notarize: true,
  },
};
