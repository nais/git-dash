// Default dashboard configuration (safe to commit).
// For local overrides / preconfigured token, create `config.local.js` (gitignored):
//   window.NAIS_DASH_CONFIG = {
//     targets: "nais, sechmann, navikt/naisdevice",
//     branchMode: "default", // "default" | "all"
//     token: "ghp_...",
//   };
window.NAIS_DASH_CONFIG = Object.assign(
  {
    targets: "nais",
    branchMode: "default", // "default" | "all"
    cacheTtlMinutes: 15,
    token: "",
  },
  window.NAIS_DASH_CONFIG || {}
);
