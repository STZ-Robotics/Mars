// Registry of verified features.
//
// This used to live in the `Mars-marketplace` repo and was downloaded at run
// time (`registry.json`). That repo no longer exists: the list is now
// `supported-packages.json`, at the root of this repo, and it travels compiled
// into the app -- that is why vite needs `server.fs.allow` to see it in dev.
//
// The only thing downloaded from the network is each feature's
// `MarsFeature.json`, so the versions are still upstream's; what stays fixed per
// release is WHICH features appear in the catalog. To add one, edit the JSON at
// the root and publish a MARS Desktop version.
import registry from "../../../../supported-packages.json"

/** URLs of the verified `MarsFeature.json` files, in the file's order. */
export const SUPPORTED_FEATURE_URLS: string[] = registry.verifiedFeatures.filter(
  url => url.trim() !== "",
)

/** The registry format's version, in case the schema changes some day. */
export const REGISTRY_VERSION: string = registry.registryVersion

/** Date (YYYY-MM-DD) of the file's last edit. */
export const REGISTRY_LAST_UPDATED: string = registry.lastUpdated
